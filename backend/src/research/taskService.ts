import { db as mainDb } from '../utils/database';
import { getResearchDb } from './db';
import { importSweepCandidates, registerSweepRun } from './profileService';

export type SweepTaskStatus = 'new' | 'selected' | 'in_sweep' | 'done' | 'ignored';
export type SweepRunMode = 'light' | 'heavy';

const normalizeSweepRunMode = (value: unknown): SweepRunMode => {
  const text = String(value || '').trim().toLowerCase();
  return text === 'heavy' ? 'heavy' : 'light';
};

const getModeTaskLimit = (mode: SweepRunMode): number => {
  return mode === 'heavy' ? 1000 : 120;
};

export type ResearchSweepTask = {
  id: number;
  source: string;
  source_request_id: number | null;
  tenant_id: number | null;
  tenant_name: string;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  note: string;
  request_status: string;
  status: SweepTaskStatus;
  is_selected: number;
  requested_at: string | null;
  selected_at: string | null;
  last_sweep_run_id: number | null;
  last_sweep_at: string | null;
  created_at: string;
  updated_at: string;
};

const normalizeSymbol = (value: unknown): string => String(value || '').trim().toUpperCase();

const parseMarket = (marketRaw: string): { base_symbol: string; quote_symbol: string } => {
  const market = String(marketRaw || '').trim().toUpperCase();
  if (!market) {
    return { base_symbol: '', quote_symbol: '' };
  }
  if (market.includes('/')) {
    const [base, quote] = market.split('/');
    return {
      base_symbol: normalizeSymbol(base),
      quote_symbol: normalizeSymbol(quote),
    };
  }
  return { base_symbol: market, quote_symbol: '' };
};

const startOfDayUtc = (date: Date): Date => {
  const next = new Date(date);
  next.setUTCHours(0, 0, 0, 0);
  return next;
};

export const syncClientBacktestRequestsToResearchTasks = async (): Promise<{ imported: number; pendingRequests: number; tasksTotal: number }> => {
  const rdb = getResearchDb();

  const pendingRows = await mainDb.all(
    `SELECT r.id, r.tenant_id, r.base_symbol, r.quote_symbol, r.interval, r.note, r.status, r.created_at,
            COALESCE(t.display_name, '') AS tenant_name
     FROM strategy_backtest_pair_requests r
     LEFT JOIN tenants t ON t.id = r.tenant_id
     WHERE r.status IN ('pending', 'approved', 'in_sweep')
     ORDER BY r.id DESC
     LIMIT 1000`
  ) as Array<Record<string, unknown>>;

  let imported = 0;
  for (const row of pendingRows) {
    const result = await rdb.run(
      `INSERT OR IGNORE INTO research_sweep_tasks (
         source, source_request_id, tenant_id, tenant_name,
         base_symbol, quote_symbol, interval, note,
         request_status, status, is_selected, requested_at,
         created_at, updated_at
       ) VALUES (
         'client_backtest_request', ?, ?, ?,
         ?, ?, ?, ?,
         ?, 'new', 0, ?,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      [
        Number(row.id),
        Number(row.tenant_id || 0) || null,
        String(row.tenant_name || ''),
        normalizeSymbol(row.base_symbol),
        normalizeSymbol(row.quote_symbol),
        String(row.interval || '1h'),
        String(row.note || ''),
        String(row.status || 'pending'),
        String(row.created_at || ''),
      ]
    );
    if (Number(result?.changes || 0) > 0) {
      imported += 1;
    }
  }

  const pendingCountRow = await mainDb.get(
    `SELECT COUNT(*) AS c FROM strategy_backtest_pair_requests WHERE status IN ('pending', 'approved', 'in_sweep')`
  ) as { c?: number } | undefined;

  const tasksTotalRow = await rdb.get('SELECT COUNT(*) AS c FROM research_sweep_tasks') as { c?: number } | undefined;

  return {
    imported,
    pendingRequests: Number(pendingCountRow?.c || 0),
    tasksTotal: Number(tasksTotalRow?.c || 0),
  };
};

export const listResearchSweepTasks = async (options?: {
  status?: SweepTaskStatus;
  onlySelected?: boolean;
  limit?: number;
}): Promise<ResearchSweepTask[]> => {
  const rdb = getResearchDb();
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options?.status) {
    where.push('status = ?');
    params.push(options.status);
  }
  if (options?.onlySelected) {
    where.push('is_selected = 1');
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.max(1, Math.min(1000, Number(options?.limit || 300)));

  const rows = await rdb.all(
    `SELECT *
     FROM research_sweep_tasks
     ${whereSql}
     ORDER BY is_selected DESC, requested_at DESC, id DESC
     LIMIT ${limit}`,
    params
  );

  return (rows || []) as ResearchSweepTask[];
};

export const setResearchSweepTaskSelection = async (taskIds: number[], isSelected: boolean): Promise<{ updated: number }> => {
  const rdb = getResearchDb();
  const ids = taskIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (ids.length === 0) {
    return { updated: 0 };
  }

  const placeholders = ids.map(() => '?').join(', ');
  const result = await rdb.run(
    `UPDATE research_sweep_tasks
     SET is_selected = ?,
         status = CASE
           WHEN status IN ('done', 'ignored') THEN status
           WHEN ? = 1 THEN 'selected'
           ELSE 'new'
         END,
         selected_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE selected_at END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (${placeholders})`,
    [isSelected ? 1 : 0, isSelected ? 1 : 0, isSelected ? 1 : 0, ...ids]
  );

  return { updated: Number(result?.changes || 0) };
};

export const markResearchSweepTasks = async (taskIds: number[], status: Extract<SweepTaskStatus, 'done' | 'ignored' | 'new'>): Promise<{ updated: number }> => {
  const rdb = getResearchDb();
  const ids = taskIds
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (ids.length === 0) {
    return { updated: 0 };
  }

  const placeholders = ids.map(() => '?').join(', ');
  const result = await rdb.run(
    `UPDATE research_sweep_tasks
     SET status = ?,
         is_selected = CASE WHEN ? IN ('done', 'ignored') THEN 0 ELSE is_selected END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id IN (${placeholders})`,
    [status, status, ...ids]
  );

  return { updated: Number(result?.changes || 0) };
};

const resolveAutoPeriod = async (): Promise<{ dateFrom: string; dateTo: string; lagDays: number }> => {
  const rdb = getResearchDb();
  const latestSweep = await rdb.get(
    `SELECT COALESCE(completed_at, created_at) AS at_utc
     FROM sweep_runs
     ORDER BY id DESC
     LIMIT 1`
  ) as { at_utc?: string | null } | undefined;

  const now = new Date();
  const dateTo = startOfDayUtc(now);

  const latestMs = Date.parse(String(latestSweep?.at_utc || ''));
  if (!Number.isFinite(latestMs)) {
    const from = new Date(dateTo);
    from.setUTCDate(from.getUTCDate() - 30);
    return {
      dateFrom: from.toISOString().slice(0, 10),
      dateTo: dateTo.toISOString().slice(0, 10),
      lagDays: 30,
    };
  }

  const lastDate = startOfDayUtc(new Date(latestMs));
  const from = new Date(lastDate);
  from.setUTCDate(from.getUTCDate() + 1);

  const lagDays = Math.max(0, Math.floor((dateTo.getTime() - lastDate.getTime()) / 86_400_000));

  return {
    dateFrom: from.toISOString().slice(0, 10),
    dateTo: dateTo.toISOString().slice(0, 10),
    lagDays,
  };
};

export const runSweepFromSelectedTasks = async (input?: {
  taskIds?: number[];
  dateFrom?: string;
  dateTo?: string;
  interval?: string;
  markDone?: boolean;
  mode?: SweepRunMode;
}): Promise<Record<string, unknown>> => {
  const rdb = getResearchDb();

  const period = (!input?.dateFrom || !input?.dateTo)
    ? await resolveAutoPeriod()
    : {
      dateFrom: String(input.dateFrom),
      dateTo: String(input.dateTo),
      lagDays: null,
    };

  const mode = normalizeSweepRunMode(input?.mode);
  const modeTaskLimit = getModeTaskLimit(mode);

  const ids = (input?.taskIds || [])
    .map((id) => Number(id))
    .filter((id) => Number.isFinite(id) && id > 0)
    .slice(0, modeTaskLimit);

  let rows: ResearchSweepTask[] = [];
  if (ids.length > 0) {
    const placeholders = ids.map(() => '?').join(', ');
    rows = await rdb.all(
      `SELECT * FROM research_sweep_tasks WHERE id IN (${placeholders}) AND status IN ('new', 'selected')`,
      ids
    ) as ResearchSweepTask[];
  } else {
    rows = await listResearchSweepTasks({ onlySelected: true, limit: 1000 });
  }

  if (rows.length > modeTaskLimit) {
    rows = rows.slice(0, modeTaskLimit);
  }

  const intervalFallback = String(input?.interval || '').trim() || '1h';
  const sweepName = `task_sweep_${mode}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;

  const sweepRunId = await registerSweepRun({
    name: sweepName,
    description: 'Sweep generated from selected client pair backtest requests',
    resultSummary: {
      source: 'research_tasks',
      requestedTasks: rows.length,
    },
    config: {
      source: 'research_tasks',
      period,
      interval: intervalFallback,
      mode,
      modeTaskLimit,
      taskIds: rows.map((item) => item.id),
    },
  });

  const candidates = rows.map((task) => {
    const market = [task.base_symbol, task.quote_symbol].filter(Boolean).join('/');
    const marketMode = task.quote_symbol ? 'synthetic' : 'mono';
    const interval = String(task.interval || intervalFallback || '1h');

    return {
      name: `${market || task.base_symbol}-task-${task.id}`,
      strategy_type: 'DD_BattleToads',
      market_mode: marketMode,
      base_symbol: task.base_symbol,
      quote_symbol: task.quote_symbol || undefined,
      interval,
      config: {
        source: 'client_backtest_request',
        task_id: task.id,
        tenant_id: task.tenant_id,
        tenant_name: task.tenant_name,
        market,
        base_symbol: task.base_symbol,
        quote_symbol: task.quote_symbol,
        interval,
        dateFrom: period.dateFrom,
        dateTo: period.dateTo,
        note: task.note,
      },
      metrics: {
        score: 0,
      },
    };
  });

  const importResult = await importSweepCandidates(sweepRunId, candidates);

  if (rows.length > 0) {
    const placeholders = rows.map(() => '?').join(', ');
    const nextStatus = input?.markDone ? 'done' : 'in_sweep';
    await rdb.run(
      `UPDATE research_sweep_tasks
       SET status = ?, is_selected = 0, last_sweep_run_id = ?, last_sweep_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${placeholders})`,
      [nextStatus, sweepRunId, ...rows.map((item) => item.id)]
    );

    const sourceRequestIds = rows
      .map((item) => Number(item.source_request_id || 0))
      .filter((id) => Number.isFinite(id) && id > 0);

    if (sourceRequestIds.length > 0) {
      await mainDb.run(
        `UPDATE strategy_backtest_pair_requests
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id IN (${sourceRequestIds.map(() => '?').join(', ')})`,
        [nextStatus === 'done' ? 'done' : 'in_sweep', ...sourceRequestIds]
      ).catch(() => {
        // Keep research flow resilient even if source table is unavailable.
      });
    }
  }

  return {
    sweepRunId,
    period,
    lagDays: period.lagDays,
    mode,
    modeTaskLimit,
    tasks: rows.length,
    imported: importResult.imported,
    skipped: importResult.skipped,
    candidates: candidates.length,
  };
};

export const runSweepFromManualMarkets = async (input: {
  markets: string[];
  dateFrom?: string;
  dateTo?: string;
  interval?: string;
  sweepName?: string;
  description?: string;
  note?: string;
  mode?: SweepRunMode;
}): Promise<Record<string, unknown>> => {
  const rdb = getResearchDb();
  const mode = normalizeSweepRunMode(input.mode);
  const modeTaskLimit = getModeTaskLimit(mode);
  const rawMarkets = Array.isArray(input.markets) ? input.markets : [];
  const normalizedMarkets = Array.from(new Set(
    rawMarkets
      .map((item) => String(item || '').trim().toUpperCase())
      .filter(Boolean)
  )).slice(0, modeTaskLimit);

  if (normalizedMarkets.length === 0) {
    throw new Error('markets is required (example: BTC/USDT, ETH/USDT)');
  }

  const period = (!input?.dateFrom || !input?.dateTo)
    ? await resolveAutoPeriod()
    : {
      dateFrom: String(input.dateFrom),
      dateTo: String(input.dateTo),
      lagDays: null,
    };

  const intervalFallback = String(input.interval || '').trim() || '1h';
  const sweepName = String(input.sweepName || '').trim()
    || `manual_pair_sweep_${mode}_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}`;
  const description = String(input.description || '').trim() || 'Sweep generated from manual pair request';
  const note = String(input.note || '').trim();

  const sweepRunId = await registerSweepRun({
    name: sweepName,
    description,
    resultSummary: {
      source: 'research_manual_pairs',
      requestedMarkets: normalizedMarkets.length,
      period,
    },
    config: {
      source: 'research_manual_pairs',
      period,
      interval: intervalFallback,
      mode,
      modeTaskLimit,
      markets: normalizedMarkets,
      note: note || undefined,
    },
  });

  const candidates = normalizedMarkets
    .map((market, index) => {
      const parsed = parseMarket(market);
      if (!parsed.base_symbol) {
        return null;
      }

      const isSynthetic = Boolean(parsed.quote_symbol);
      const finalMarket = [parsed.base_symbol, parsed.quote_symbol].filter(Boolean).join('/');

      return {
        name: `${finalMarket || parsed.base_symbol}-manual-${index + 1}`,
        strategy_type: 'DD_BattleToads',
        market_mode: isSynthetic ? 'synthetic' : 'mono',
        base_symbol: parsed.base_symbol,
        quote_symbol: parsed.quote_symbol || undefined,
        interval: intervalFallback,
        config: {
          source: 'manual_pair_request',
          market: finalMarket,
          base_symbol: parsed.base_symbol,
          quote_symbol: parsed.quote_symbol,
          interval: intervalFallback,
          dateFrom: period.dateFrom,
          dateTo: period.dateTo,
          note: note || undefined,
        },
        metrics: {
          score: 0,
        },
      };
    })
    .filter((candidate): candidate is NonNullable<typeof candidate> => candidate !== null);

  if (candidates.length === 0) {
    throw new Error('No valid markets after parsing');
  }

  const importResult = await importSweepCandidates(sweepRunId, candidates);

  await rdb.run(
    `INSERT INTO sweep_artifacts (sweep_run_id, artifact_type, content_json, created_at)
     VALUES (?, 'manual_pairs_request', ?, CURRENT_TIMESTAMP)`,
    [
      sweepRunId,
      JSON.stringify({
        markets: normalizedMarkets,
        period,
        interval: intervalFallback,
        note: note || null,
      }),
    ]
  ).catch(() => {
    // Keep flow resilient if artifacts table is unavailable.
  });

  return {
    sweepRunId,
    period,
    lagDays: period.lagDays,
    mode,
    modeTaskLimit,
    markets: normalizedMarkets.length,
    imported: importResult.imported,
    skipped: importResult.skipped,
    candidates: candidates.length,
  };
};

export const listSweepPairs = async (sweepRunId: number): Promise<Array<{ market: string; interval: string; profiles: number }>> => {
  const rdb = getResearchDb();
  const rows = await rdb.all(
    `SELECT base_symbol, quote_symbol, interval, COUNT(*) AS profiles
     FROM strategy_profiles
     WHERE sweep_run_id = ?
     GROUP BY base_symbol, quote_symbol, interval
     ORDER BY profiles DESC, base_symbol ASC`,
    [sweepRunId]
  ) as Array<{ base_symbol?: string; quote_symbol?: string; interval?: string; profiles?: number }>;

  return (rows || []).map((item) => ({
    market: [String(item.base_symbol || ''), String(item.quote_symbol || '')].filter(Boolean).join('/'),
    interval: String(item.interval || '1h'),
    profiles: Number(item.profiles || 0),
  }));
};

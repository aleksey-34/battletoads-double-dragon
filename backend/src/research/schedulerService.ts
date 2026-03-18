import fs from 'fs';
import { getDbFilePath, db as mainDb } from '../utils/database';
import { loadLatestClientCatalog, loadLatestSweep } from '../saas/service';
import logger from '../utils/logger';
import { getResearchDb, getResearchDbFilePath } from './db';
import { importSweepCandidates, registerSweepRun } from './profileService';

type SchedulerJobKey = 'daily_incremental_sweep';
type SchedulerStatus = 'idle' | 'running' | 'done' | 'failed' | 'skipped';

type SchedulerJob = {
  id: number;
  job_key: SchedulerJobKey;
  title: string;
  is_enabled: number;
  schedule_kind: string;
  hour_utc: number;
  minute_utc: number;
  last_status: SchedulerStatus;
  last_run_at: string | null;
  last_error: string | null;
  next_run_at: string | null;
  run_count: number;
  created_at: string;
  updated_at: string;
};

const DEFAULT_JOBS: Array<{ job_key: SchedulerJobKey; title: string; hour_utc: number; minute_utc: number }> = [
  {
    job_key: 'daily_incremental_sweep',
    title: 'Daily incremental sweep sync',
    hour_utc: 3,
    minute_utc: 15,
  },
];

const toIsoNow = (): string => new Date().toISOString();

const clampInt = (value: number, min: number, max: number): number => {
  const rounded = Math.floor(value);
  return Math.min(max, Math.max(min, rounded));
};

const computeNextDailyRunAtUtc = (hourUtc: number, minuteUtc: number, fromDate?: Date): string => {
  const now = fromDate || new Date();
  const next = new Date(now);
  next.setUTCSeconds(0, 0);
  next.setUTCHours(hourUtc, minuteUtc, 0, 0);
  if (next.getTime() <= now.getTime()) {
    next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
};

export const ensureDefaultSchedulerJobs = async (): Promise<void> => {
  const db = getResearchDb();

  for (const item of DEFAULT_JOBS) {
    await db.run(
      `INSERT OR IGNORE INTO research_scheduler_jobs
         (job_key, title, is_enabled, schedule_kind, hour_utc, minute_utc, last_status, next_run_at, run_count, created_at, updated_at)
       VALUES (?, ?, 1, 'daily', ?, ?, 'idle', ?, 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [item.job_key, item.title, item.hour_utc, item.minute_utc, computeNextDailyRunAtUtc(item.hour_utc, item.minute_utc)]
    );

    await db.run(
      `UPDATE research_scheduler_jobs
       SET next_run_at = COALESCE(next_run_at, ?), updated_at = CURRENT_TIMESTAMP
       WHERE job_key = ?`,
      [computeNextDailyRunAtUtc(item.hour_utc, item.minute_utc), item.job_key]
    );
  }
};

export const listSchedulerJobs = async (): Promise<SchedulerJob[]> => {
  await ensureDefaultSchedulerJobs();
  const db = getResearchDb();
  const rows = await db.all('SELECT * FROM research_scheduler_jobs ORDER BY id ASC');
  return (rows || []) as SchedulerJob[];
};

export const updateSchedulerJob = async (
  jobKey: SchedulerJobKey,
  patch: { is_enabled?: boolean; hour_utc?: number; minute_utc?: number }
): Promise<SchedulerJob> => {
  await ensureDefaultSchedulerJobs();
  const db = getResearchDb();

  const row = await db.get('SELECT * FROM research_scheduler_jobs WHERE job_key = ?', [jobKey]) as SchedulerJob | undefined;
  if (!row) {
    throw new Error(`Scheduler job not found: ${jobKey}`);
  }

  const hourUtc = patch.hour_utc !== undefined ? clampInt(Number(patch.hour_utc), 0, 23) : Number(row.hour_utc);
  const minuteUtc = patch.minute_utc !== undefined ? clampInt(Number(patch.minute_utc), 0, 59) : Number(row.minute_utc);
  const isEnabled = patch.is_enabled !== undefined ? (patch.is_enabled ? 1 : 0) : Number(row.is_enabled);
  const nextRunAt = computeNextDailyRunAtUtc(hourUtc, minuteUtc);

  await db.run(
    `UPDATE research_scheduler_jobs
     SET is_enabled = ?, hour_utc = ?, minute_utc = ?, next_run_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE job_key = ?`,
    [isEnabled, hourUtc, minuteUtc, nextRunAt, jobKey]
  );

  const updated = await db.get('SELECT * FROM research_scheduler_jobs WHERE job_key = ?', [jobKey]) as SchedulerJob | undefined;
  if (!updated) {
    throw new Error(`Failed to reload scheduler job after update: ${jobKey}`);
  }
  return updated;
};

const parseMarket = (market: string): { base_symbol: string; quote_symbol?: string } => {
  const normalized = String(market || '').trim();
  if (!normalized) {
    return { base_symbol: '' };
  }
  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/');
    return { base_symbol: String(base || '').trim(), quote_symbol: String(quote || '').trim() || undefined };
  }
  return { base_symbol: normalized };
};

const buildCandidatesFromCatalog = (catalog: any): Array<{
  name: string;
  strategy_type: string;
  market_mode: string;
  base_symbol: string;
  quote_symbol?: string;
  interval: string;
  config: Record<string, unknown>;
  metrics?: Record<string, unknown>;
}> => {
  const offers = [
    ...(catalog?.clientCatalog?.mono || []),
    ...(catalog?.clientCatalog?.synth || []),
  ];

  const out: Array<{
    name: string;
    strategy_type: string;
    market_mode: string;
    base_symbol: string;
    quote_symbol?: string;
    interval: string;
    config: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  }> = [];

  for (const offer of offers) {
    const market = parseMarket(String(offer?.strategy?.market || ''));
    if (!market.base_symbol) {
      continue;
    }

    const strategyType = String(offer?.strategy?.type || 'DD_BattleToads');
    const marketMode = String(offer?.strategy?.mode || 'mono') === 'mono' ? 'mono' : 'synthetic';
    const params = offer?.strategy?.params || {};
    const interval = String(params?.interval || '1h');

    out.push({
      name: String(offer?.offerId || offer?.titleRu || `${market.base_symbol}-${strategyType}`),
      strategy_type: strategyType,
      market_mode: marketMode,
      base_symbol: market.base_symbol,
      quote_symbol: market.quote_symbol,
      interval,
      config: {
        name: String(offer?.strategy?.name || ''),
        strategy_type: strategyType,
        market_mode: marketMode,
        base_symbol: market.base_symbol,
        quote_symbol: market.quote_symbol,
        interval,
        ...params,
      },
      metrics: {
        ret: Number(offer?.metrics?.ret || 0),
        pf: Number(offer?.metrics?.pf || 0),
        dd: Number(offer?.metrics?.dd || 0),
        wr: Number(offer?.metrics?.wr || 0),
        trades: Number(offer?.metrics?.trades || 0),
        score: Number(offer?.metrics?.score || 0),
      },
    });
  }

  return out;
};

const runDailyIncrementalSweep = async (): Promise<{ status: SchedulerStatus; details: Record<string, unknown> }> => {
  const researchDb = getResearchDb();
  const sweep = loadLatestSweep();
  const catalog = loadLatestClientCatalog();

  if (!sweep || !catalog) {
    return {
      status: 'skipped',
      details: {
        reason: 'Latest sweep/client catalog JSON is missing in results/',
      },
    };
  }

  const dayKey = String(sweep.timestamp || toIsoNow()).slice(0, 10);
  const runName = `daily_sync_${dayKey}`;

  const existing = await researchDb.get('SELECT id FROM sweep_runs WHERE name = ? ORDER BY id DESC LIMIT 1', [runName]) as { id?: number } | undefined;
  if (existing?.id) {
    return {
      status: 'skipped',
      details: {
        reason: `Daily sync already exists for ${dayKey}`,
        sweep_run_id: Number(existing.id),
      },
    };
  }

  const sweepRunId = await registerSweepRun({
    name: runName,
    description: 'Auto daily incremental sync from latest results artifacts',
    resultSummary: {
      source: 'research_scheduler',
      sourceTimestamp: sweep.timestamp,
      counts: sweep.counts || {},
    },
    config: {
      source: 'research_scheduler',
      mode: 'daily_incremental_sync',
    },
  });

  const candidates = buildCandidatesFromCatalog(catalog);
  const importResult = await importSweepCandidates(sweepRunId, candidates);

  await researchDb.run(
    `INSERT INTO sweep_artifacts (sweep_run_id, artifact_type, content_json, created_at)
     VALUES (?, 'scheduler_daily_sync_summary', ?, CURRENT_TIMESTAMP)`,
    [
      sweepRunId,
      JSON.stringify({
        sourceTimestamp: sweep.timestamp,
        imported: importResult.imported,
        skipped: importResult.skipped,
        candidates: candidates.length,
      }),
    ]
  );

  return {
    status: 'done',
    details: {
      sweep_run_id: sweepRunId,
      imported: importResult.imported,
      skipped: importResult.skipped,
      candidates: candidates.length,
    },
  };
};

const runSchedulerJobByKey = async (jobKey: SchedulerJobKey): Promise<{ status: SchedulerStatus; details: Record<string, unknown> }> => {
  if (jobKey === 'daily_incremental_sweep') {
    return runDailyIncrementalSweep();
  }

  throw new Error(`Unknown scheduler job key: ${jobKey}`);
};

export const runSchedulerJobNow = async (jobKey: SchedulerJobKey): Promise<{ job: SchedulerJob; result: { status: SchedulerStatus; details: Record<string, unknown> } }> => {
  await ensureDefaultSchedulerJobs();
  const db = getResearchDb();

  const job = await db.get('SELECT * FROM research_scheduler_jobs WHERE job_key = ?', [jobKey]) as SchedulerJob | undefined;
  if (!job) {
    throw new Error(`Scheduler job not found: ${jobKey}`);
  }

  await db.run(
    `UPDATE research_scheduler_jobs
     SET last_status = 'running', last_error = '', last_run_at = ?, updated_at = CURRENT_TIMESTAMP
     WHERE job_key = ?`,
    [toIsoNow(), jobKey]
  );

  const hourUtc = clampInt(Number(job.hour_utc), 0, 23);
  const minuteUtc = clampInt(Number(job.minute_utc), 0, 59);

  try {
    const result = await runSchedulerJobByKey(jobKey);
    await db.run(
      `UPDATE research_scheduler_jobs
       SET last_status = ?,
           last_error = '',
           run_count = run_count + 1,
           next_run_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE job_key = ?`,
      [result.status, computeNextDailyRunAtUtc(hourUtc, minuteUtc), jobKey]
    );

    const updated = await db.get('SELECT * FROM research_scheduler_jobs WHERE job_key = ?', [jobKey]) as SchedulerJob | undefined;
    if (!updated) {
      throw new Error(`Scheduler job reload failed after run: ${jobKey}`);
    }

    return { job: updated, result };
  } catch (error) {
    const message = (error as Error).message;
    await db.run(
      `UPDATE research_scheduler_jobs
       SET last_status = 'failed',
           last_error = ?,
           next_run_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE job_key = ?`,
      [message, computeNextDailyRunAtUtc(hourUtc, minuteUtc), jobKey]
    );
    logger.error(`[researchScheduler] ${jobKey} failed: ${message}`);
    throw error;
  }
};

export const runDueResearchSchedulerJobs = async (limit: number = 1): Promise<Array<{ job_key: string; status: string }>> => {
  await ensureDefaultSchedulerJobs();
  const db = getResearchDb();

  const due = await db.all(
    `SELECT *
     FROM research_scheduler_jobs
     WHERE is_enabled = 1
       AND COALESCE(next_run_at, '') <> ''
       AND next_run_at <= ?
       AND last_status <> 'running'
     ORDER BY next_run_at ASC
     LIMIT ?`,
    [toIsoNow(), Math.max(1, Math.floor(limit))]
  ) as SchedulerJob[];

  const out: Array<{ job_key: string; status: string }> = [];
  for (const item of due) {
    try {
      const result = await runSchedulerJobNow(item.job_key);
      out.push({ job_key: item.job_key, status: result.result.status });
    } catch {
      out.push({ job_key: item.job_key, status: 'failed' });
    }
  }

  return out;
};

const fileInfo = (filePath: string): { path: string; exists: boolean; sizeBytes: number; mtimeUtc: string | null } => {
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return { path: filePath, exists: false, sizeBytes: 0, mtimeUtc: null };
    }
    const stat = fs.statSync(filePath);
    return {
      path: filePath,
      exists: true,
      sizeBytes: stat.size,
      mtimeUtc: stat.mtime.toISOString(),
    };
  } catch {
    return { path: filePath, exists: false, sizeBytes: 0, mtimeUtc: null };
  }
};

export const getResearchDbObservability = async (): Promise<Record<string, unknown>> => {
  const researchDb = getResearchDb();

  const researchTables = [
    'strategy_profiles',
    'sweep_runs',
    'sweep_artifacts',
    'preview_jobs',
    'client_presets',
    'publish_log',
    'backtest_runs',
    'research_scheduler_jobs',
  ];

  const mainTables = [
    'strategies',
    'api_keys',
    'tenants',
    'client_users',
    'subscriptions',
    'strategy_client_profiles',
    'algofund_profiles',
    'algofund_start_stop_requests',
    'saas_audit_log',
  ];

  const researchCounts: Record<string, number | null> = {};
  for (const table of researchTables) {
    try {
      const row = await researchDb.get(`SELECT COUNT(*) AS c FROM ${table}`) as { c?: number } | undefined;
      researchCounts[table] = Number(row?.c ?? 0);
    } catch {
      researchCounts[table] = null;
    }
  }

  const mainCounts: Record<string, number | null> = {};
  for (const table of mainTables) {
    try {
      const row = await mainDb.get(`SELECT COUNT(*) AS c FROM ${table}`) as { c?: number } | undefined;
      mainCounts[table] = Number(row?.c ?? 0);
    } catch {
      mainCounts[table] = null;
    }
  }

  return {
    atUtc: toIsoNow(),
    files: {
      mainDb: fileInfo(getDbFilePath()),
      researchDb: fileInfo(getResearchDbFilePath()),
    },
    rowCounts: {
      main: mainCounts,
      research: researchCounts,
    },
  };
};

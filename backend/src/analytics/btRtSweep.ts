/**
 * BT vs RT Daily Snapshot Service
 * Captures a daily aggregated snapshot per algofund client comparing
 * runtime performance against backtest expectations.
 */
import { db } from '../utils/database';
import logger from '../utils/logger';

// ---------------------------------------------------------------------------
// Ensure table exists (idempotent, called on first use)
// ---------------------------------------------------------------------------
let tableReady = false;

export const ensureBtRtTable = async (): Promise<void> => {
  if (tableReady) {
    return;
  }
  await db.exec(`
    CREATE TABLE IF NOT EXISTS bt_rt_daily_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      snapshot_date TEXT NOT NULL,
      api_key_name TEXT NOT NULL,
      tenant_id INTEGER,
      system_name TEXT NOT NULL DEFAULT '',
      -- RT metrics
      rt_equity_usd REAL DEFAULT 0,
      rt_equity_start_usd REAL DEFAULT 0,
      rt_return_pct REAL DEFAULT 0,
      rt_entries INTEGER DEFAULT 0,
      rt_exits INTEGER DEFAULT 0,
      rt_unrealized_pnl REAL DEFAULT 0,
      rt_drawdown_pct REAL DEFAULT 0,
      rt_leverage_avg REAL DEFAULT 0,
      rt_strategies_active INTEGER DEFAULT 0,
      -- BT reference (from latest backtest_run for the source system strategies)
      bt_total_return_pct REAL,
      bt_max_dd_pct REAL,
      bt_win_rate REAL,
      bt_profit_factor REAL,
      bt_source_run_id INTEGER,
      -- Drift aggregates (from drift_alerts in the 24h window)
      drift_alerts_critical INTEGER DEFAULT 0,
      drift_alerts_warn INTEGER DEFAULT 0,
      drift_avg_pct REAL DEFAULT 0,
      drift_flag TEXT DEFAULT 'ok',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(snapshot_date, api_key_name)
    );

    CREATE INDEX IF NOT EXISTS idx_bt_rt_snapshots_date
      ON bt_rt_daily_snapshots (snapshot_date DESC);

    CREATE INDEX IF NOT EXISTS idx_bt_rt_snapshots_key_date
      ON bt_rt_daily_snapshots (api_key_name, snapshot_date DESC);
  `);
  tableReady = true;
};

// ---------------------------------------------------------------------------
// Core snapshot computation
// ---------------------------------------------------------------------------

type BtRtSnapshot = {
  snapshot_date: string;
  api_key_name: string;
  tenant_id: number | null;
  system_name: string;
  rt_equity_usd: number;
  rt_equity_start_usd: number;
  rt_return_pct: number;
  rt_entries: number;
  rt_exits: number;
  rt_unrealized_pnl: number;
  rt_drawdown_pct: number;
  rt_leverage_avg: number;
  rt_strategies_active: number;
  bt_total_return_pct: number | null;
  bt_max_dd_pct: number | null;
  bt_win_rate: number | null;
  bt_profit_factor: number | null;
  bt_source_run_id: number | null;
  drift_alerts_critical: number;
  drift_alerts_warn: number;
  drift_avg_pct: number;
  drift_flag: 'ok' | 'warn' | 'alert';
};

const computeSnapshotForKey = async (
  apiKeyName: string,
  apiKeyId: number,
  tenantId: number | null,
  systemName: string,
  snapshotDateUtc: string,
): Promise<BtRtSnapshot> => {
  // Date range: midnight-to-midnight UTC for snapshot_date
  // monitoring_snapshots.recorded_at is stored as 'YYYY-MM-DD HH:MM:SS' (SQLite default, no T)
  const dateStart = `${snapshotDateUtc} 00:00:00`;
  const dateEnd = `${snapshotDateUtc} 23:59:59`;
  // live_trade_events.created_at is unix milliseconds (INTEGER)
  const startMs = new Date(`${snapshotDateUtc}T00:00:00.000Z`).getTime();
  const endMs = new Date(`${snapshotDateUtc}T23:59:59.999Z`).getTime();

  // --- RT: latest equity for the day ---
  const latestSnap = await db.get(
    `SELECT equity_usd, unrealized_pnl, drawdown_percent, effective_leverage
     FROM monitoring_snapshots
     WHERE api_key_id = ? AND recorded_at BETWEEN ? AND ?
     ORDER BY id DESC LIMIT 1`,
    [apiKeyId, dateStart, dateEnd]
  ) as { equity_usd?: number; unrealized_pnl?: number; drawdown_percent?: number; effective_leverage?: number } | undefined;

  // RT: first equity of the day (start of period)
  const firstSnap = await db.get(
    `SELECT equity_usd
     FROM monitoring_snapshots
     WHERE api_key_id = ? AND recorded_at BETWEEN ? AND ?
     ORDER BY id ASC LIMIT 1`,
    [apiKeyId, dateStart, dateEnd]
  ) as { equity_usd?: number } | undefined;

  const rtEquityEnd = Number(latestSnap?.equity_usd ?? 0);
  const rtEquityStart = Number(firstSnap?.equity_usd ?? rtEquityEnd);
  const rtReturnPct = rtEquityStart > 0
    ? ((rtEquityEnd - rtEquityStart) / rtEquityStart) * 100
    : 0;

  // --- RT: trade events for the day ---
  const tradeCountRow = await db.get(
    `SELECT
       SUM(CASE WHEN lte.trade_type = 'entry' THEN 1 ELSE 0 END) AS entries,
       SUM(CASE WHEN lte.trade_type = 'exit' THEN 1 ELSE 0 END) AS exits
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ?
        AND CAST(lte.created_at AS INTEGER) BETWEEN ? AND ?`,
      [apiKeyName, startMs, endMs]
  ) as { entries?: number; exits?: number } | undefined;

  // --- RT: active strategies count ---
  const activeStratsRow = await db.get(
    `SELECT COUNT(*) AS cnt
     FROM strategies s
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ?
       AND (s.is_archived IS NULL OR s.is_archived = 0)
       AND s.is_active = 1`,
    [apiKeyName]
  ) as { cnt?: number } | undefined;

  // --- BT: find backtest_run that best matches this client's source strategies ---
  // Client strategy names encode source IDs as "::SID<id>" suffix (e.g. SAAS::key::MONO::type::SYM::SID163460).
  // We extract those IDs and find the backtest_run with the highest overlap.
  const sourceKeyName = systemName.includes('BTDD_D1')
    ? 'BTDD_D1'
    : systemName.split('::')[1] || 'BTDD_D1';

  const clientStratRows = await db.all(
    `SELECT s.name
     FROM strategies s
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ?
       AND (s.is_archived IS NULL OR s.is_archived = 0)`,
    [apiKeyName]
  ) as Array<{ name: string }>;

  const sourceStratIds: number[] = [];
  for (const row of clientStratRows) {
    const m = row.name.match(/::SID(\d+)$/);
    if (m) sourceStratIds.push(Number(m[1]));
  }

  let btRunId: number | null = null;
  let btTotalReturn: number | null = null;
  let btMaxDD: number | null = null;
  let btWinRate: number | null = null;
  let btProfitFactor: number | null = null;

  if (sourceStratIds.length > 0) {
    // Fetch recent backtest_runs for the source key and pick the one with most overlap
    const btRuns = await db.all(
      `SELECT id, strategy_ids, total_return_percent, max_drawdown_percent, win_rate_percent, profit_factor
       FROM backtest_runs
       WHERE api_key_name = ?
         AND created_at <= ?
       ORDER BY id DESC
       LIMIT 50`,
      [sourceKeyName, dateEnd]
    ) as Array<{ id: number; strategy_ids: string; total_return_percent?: number; max_drawdown_percent?: number; win_rate_percent?: number; profit_factor?: number }>;

    let bestRun: typeof btRuns[0] | undefined;
    let bestOverlap = 0;

    for (const run of btRuns) {
      const runIds: number[] = run.strategy_ids ? (JSON.parse(run.strategy_ids) as number[]) : [];
      const overlap = sourceStratIds.filter((id) => runIds.includes(id)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        bestRun = run;
      }
    }

    if (bestRun && bestOverlap > 0) {
      btRunId = bestRun.id;
      btTotalReturn = Number(bestRun.total_return_percent ?? 0);
      btMaxDD = Number(bestRun.max_drawdown_percent ?? 0);
      btWinRate = Number(bestRun.win_rate_percent ?? 0);
      btProfitFactor = Number(bestRun.profit_factor ?? 0);
    }
  }

  if (btRunId === null) {
    // Fallback: latest backtest_run for the source key name
    const btRow = await db.get(
      `SELECT id, total_return_percent, max_drawdown_percent, win_rate_percent, profit_factor
       FROM backtest_runs
       WHERE api_key_name = ?
         AND created_at <= ?
       ORDER BY id DESC LIMIT 1`,
      [sourceKeyName, dateEnd]
    ) as { id?: number; total_return_percent?: number; max_drawdown_percent?: number; win_rate_percent?: number; profit_factor?: number } | undefined;

    if (btRow?.id) {
      btRunId = Number(btRow.id);
      btTotalReturn = Number(btRow.total_return_percent ?? 0);
      btMaxDD = Number(btRow.max_drawdown_percent ?? 0);
      btWinRate = Number(btRow.win_rate_percent ?? 0);
      btProfitFactor = Number(btRow.profit_factor ?? 0);
    }
  }

  // --- Drift alerts for the day (from drift_alerts per strategy on this key) ---
  const driftAgg = await db.get(
    `SELECT
       SUM(CASE WHEN da.severity = 'critical' THEN 1 ELSE 0 END) AS critical_cnt,
       SUM(CASE WHEN da.severity = 'warning' THEN 1 ELSE 0 END) AS warn_cnt,
       AVG(ABS(da.drift_percent)) AS avg_drift
     FROM drift_alerts da
     JOIN strategies s ON s.id = da.strategy_id
     JOIN api_keys ak ON ak.id = s.api_key_id
     WHERE ak.name = ?
       AND CAST(da.created_at AS INTEGER) BETWEEN ? AND ?`,
    [apiKeyName, startMs, endMs]
  ) as { critical_cnt?: number; warn_cnt?: number; avg_drift?: number } | undefined;

  const criticalCount = Number(driftAgg?.critical_cnt ?? 0);
  const warnCount = Number(driftAgg?.warn_cnt ?? 0);
  const avgDrift = Number(driftAgg?.avg_drift ?? 0);

  let driftFlag: 'ok' | 'warn' | 'alert' = 'ok';
  if (criticalCount > 0) {
    driftFlag = 'alert';
  } else if (warnCount > 0) {
    driftFlag = 'warn';
  }

  return {
    snapshot_date: snapshotDateUtc,
    api_key_name: apiKeyName,
    tenant_id: tenantId,
    system_name: systemName,
    rt_equity_usd: rtEquityEnd,
    rt_equity_start_usd: rtEquityStart,
    rt_return_pct: Math.round(rtReturnPct * 10000) / 10000,
    rt_entries: Number(tradeCountRow?.entries ?? 0),
    rt_exits: Number(tradeCountRow?.exits ?? 0),
    rt_unrealized_pnl: Number(latestSnap?.unrealized_pnl ?? 0),
    rt_drawdown_pct: Number(latestSnap?.drawdown_percent ?? 0),
    rt_leverage_avg: Number(latestSnap?.effective_leverage ?? 0),
    rt_strategies_active: Number(activeStratsRow?.cnt ?? 0),
    bt_total_return_pct: btTotalReturn,
    bt_max_dd_pct: btMaxDD,
    bt_win_rate: btWinRate,
    bt_profit_factor: btProfitFactor,
    bt_source_run_id: btRunId,
    drift_alerts_critical: criticalCount,
    drift_alerts_warn: warnCount,
    drift_avg_pct: Math.round(avgDrift * 100) / 100,
    drift_flag: driftFlag,
  };
};

// ---------------------------------------------------------------------------
// Public: run the daily sweep for a given date (defaults to today UTC)
// ---------------------------------------------------------------------------

export const runBtRtDailySweep = async (
  dateOverride?: string,
): Promise<{
  date: string;
  processed: number;
  skipped: number;
  errors: number;
  details: Array<{ api_key_name: string; status: 'inserted' | 'updated' | 'skipped' | 'error'; reason?: string }>;
}> => {
  await ensureBtRtTable();

  const snapshotDate = dateOverride
    ? String(dateOverride).slice(0, 10)
    : new Date().toISOString().slice(0, 10);

  logger.info(`[btRtSweep] Running daily snapshot for ${snapshotDate}`);

  // Get all active algofund profiles
  const profiles = await db.all(
    `SELECT ap.tenant_id, ap.assigned_api_key_name, ap.published_system_name,
            ap.actual_enabled, ap.requested_enabled,
            ak.id AS api_key_id
     FROM algofund_profiles ap
     JOIN api_keys ak ON ak.name = ap.assigned_api_key_name
     WHERE ap.actual_enabled = 1
       AND TRIM(COALESCE(ap.assigned_api_key_name, '')) <> ''`,
    []
  ) as Array<{
    tenant_id: number;
    assigned_api_key_name: string;
    published_system_name: string;
    actual_enabled: number;
    requested_enabled: number;
    api_key_id: number;
  }>;

  logger.info(`[btRtSweep] Found ${profiles.length} active algofund profiles`);

  let processed = 0;
  let skipped = 0;
  let errors = 0;
  const details: Array<{ api_key_name: string; status: 'inserted' | 'updated' | 'skipped' | 'error'; reason?: string }> = [];

  for (const profile of profiles) {
    const keyName = profile.assigned_api_key_name;
    try {
      const snap = await computeSnapshotForKey(
        keyName,
        profile.api_key_id,
        profile.tenant_id ?? null,
        profile.published_system_name ?? '',
        snapshotDate,
      );

      // Upsert
      await db.run(
        `INSERT INTO bt_rt_daily_snapshots
           (snapshot_date, api_key_name, tenant_id, system_name,
            rt_equity_usd, rt_equity_start_usd, rt_return_pct,
            rt_entries, rt_exits, rt_unrealized_pnl, rt_drawdown_pct, rt_leverage_avg, rt_strategies_active,
            bt_total_return_pct, bt_max_dd_pct, bt_win_rate, bt_profit_factor, bt_source_run_id,
            drift_alerts_critical, drift_alerts_warn, drift_avg_pct, drift_flag)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(snapshot_date, api_key_name) DO UPDATE SET
           system_name = excluded.system_name,
           rt_equity_usd = excluded.rt_equity_usd,
           rt_equity_start_usd = excluded.rt_equity_start_usd,
           rt_return_pct = excluded.rt_return_pct,
           rt_entries = excluded.rt_entries,
           rt_exits = excluded.rt_exits,
           rt_unrealized_pnl = excluded.rt_unrealized_pnl,
           rt_drawdown_pct = excluded.rt_drawdown_pct,
           rt_leverage_avg = excluded.rt_leverage_avg,
           rt_strategies_active = excluded.rt_strategies_active,
           bt_total_return_pct = excluded.bt_total_return_pct,
           bt_max_dd_pct = excluded.bt_max_dd_pct,
           bt_win_rate = excluded.bt_win_rate,
           bt_profit_factor = excluded.bt_profit_factor,
           bt_source_run_id = excluded.bt_source_run_id,
           drift_alerts_critical = excluded.drift_alerts_critical,
           drift_alerts_warn = excluded.drift_alerts_warn,
           drift_avg_pct = excluded.drift_avg_pct,
           drift_flag = excluded.drift_flag,
           created_at = created_at`,
        [
          snap.snapshot_date, snap.api_key_name, snap.tenant_id, snap.system_name,
          snap.rt_equity_usd, snap.rt_equity_start_usd, snap.rt_return_pct,
          snap.rt_entries, snap.rt_exits, snap.rt_unrealized_pnl, snap.rt_drawdown_pct, snap.rt_leverage_avg, snap.rt_strategies_active,
          snap.bt_total_return_pct, snap.bt_max_dd_pct, snap.bt_win_rate, snap.bt_profit_factor, snap.bt_source_run_id,
          snap.drift_alerts_critical, snap.drift_alerts_warn, snap.drift_avg_pct, snap.drift_flag,
        ]
      );

      processed++;
      details.push({ api_key_name: keyName, status: 'inserted' });
    } catch (err) {
      errors++;
      const msg = (err as Error).message;
      logger.error(`[btRtSweep] Error for key ${keyName}: ${msg}`);
      details.push({ api_key_name: keyName, status: 'error', reason: msg });
    }
  }

  logger.info(`[btRtSweep] Done: processed=${processed} skipped=${skipped} errors=${errors}`);
  return { date: snapshotDate, processed, skipped, errors, details };
};

// ---------------------------------------------------------------------------
// Public: query snapshots
// ---------------------------------------------------------------------------

export const getBtRtSnapshots = async (params: {
  tenantId?: number;
  apiKeyName?: string;
  days?: number;
  limit?: number;
}): Promise<unknown[]> => {
  await ensureBtRtTable();

  const days = Math.max(1, Math.min(365, Number(params.days || 30)));
  const limit = Math.max(1, Math.min(5000, Number(params.limit || 200)));
  const fromDate = new Date();
  fromDate.setUTCDate(fromDate.getUTCDate() - days);
  const fromDateStr = fromDate.toISOString().slice(0, 10);

  const conditions: string[] = ['snapshot_date >= ?'];
  const bindings: unknown[] = [fromDateStr];

  if (params.tenantId) {
    conditions.push('tenant_id = ?');
    bindings.push(params.tenantId);
  }
  if (params.apiKeyName) {
    conditions.push('api_key_name = ?');
    bindings.push(params.apiKeyName);
  }

  bindings.push(limit);

  const rows = await db.all(
    `SELECT * FROM bt_rt_daily_snapshots
     WHERE ${conditions.join(' AND ')}
     ORDER BY snapshot_date DESC, api_key_name ASC
     LIMIT ?`,
    bindings
  );

  return Array.isArray(rows) ? rows : [];
};

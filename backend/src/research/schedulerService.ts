import fs from 'fs';
import { getDbFilePath, db as mainDb } from '../utils/database';
import { getLatestResearchArtifactsStatus, loadCatalogAndSweepWithFallback, refreshOfferStoreSnapshotsFromSweep, syncAllTenantStrategyMaxDeposit } from '../saas/service';
import { runBtRtDailySweep } from '../analytics/btRtSweep';
import logger from '../utils/logger';
import { getResearchDb, getResearchDbFilePath } from './db';
import { importSweepCandidates, registerSweepRun } from './profileService';
import { startFullHistoricalSweepJob } from './fullHistoricalSweepService';

type SchedulerJobKey = 'daily_incremental_sweep' | 'bt_rt_daily_snapshot';
type SchedulerStatus = 'idle' | 'running' | 'done' | 'failed' | 'skipped';
type SweepRunMode = 'light' | 'heavy';

const normalizeSweepRunMode = (value: unknown): SweepRunMode => {
  const text = String(value || '').trim().toLowerCase();
  return text === 'heavy' ? 'heavy' : 'light';
};

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

type BackfillJobStatus = 'queued' | 'running' | 'done' | 'failed';

type BackfillJobRow = {
  id: number;
  job_key: string;
  mode: SweepRunMode;
  status: BackfillJobStatus;
  requested_max_days: number;
  analyzed_days: number;
  missing_days: number;
  processed_days: number;
  created_runs: number;
  skipped_days: number;
  current_day_key: string;
  eta_seconds: number;
  progress_percent: number;
  details_json: string;
  error: string;
  started_at: string;
  updated_at: string;
  finished_at: string | null;
};

let runningBackfillJobId: number | null = null;
const delay = async (ms: number): Promise<void> => {
  if (ms <= 0) {
    return;
  }
  await new Promise((resolve) => setTimeout(resolve, ms));
};

const DEFAULT_JOBS: Array<{ job_key: SchedulerJobKey; title: string; hour_utc: number; minute_utc: number }> = [
  {
    job_key: 'daily_incremental_sweep',
    title: 'Daily incremental sweep sync',
    hour_utc: 3,
    minute_utc: 15,
  },
  {
    job_key: 'bt_rt_daily_snapshot',
    title: 'Daily BT vs RT snapshot',
    hour_utc: 0,
    minute_utc: 30,
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
  const sourceStatus = getLatestResearchArtifactsStatus();

  if (!sourceStatus.catalogFresh || !sourceStatus.sweepFresh) {
    const refreshJob = await startFullHistoricalSweepJob({
      mode: 'light',
      apiKeyName: 'BTDD_D1',
      strategyPrefix: 'DAILYSWEEP',
      systemName: 'Daily Sweep Refresh',
      maxRuns: 96,
      exhaustiveMode: false,
      turboMode: true,
      resumeEnabled: true,
      maxMembers: 6,
    });

    return {
      status: 'done',
      details: {
        reason: 'Source artifacts are stale; queued full historical sweep refresh instead of importing stale JSON',
        sourceStatus,
        queuedHistoricalSweep: refreshJob,
      },
    };
  }

  const { sweep, catalog } = await loadCatalogAndSweepWithFallback();

  const sourceTimestamp = String(sweep?.timestamp || toIsoNow());
  // Use current UTC day for scheduler idempotency.
  // Source sweep timestamp can be stale (historical artifact), which would otherwise block new daily runs.
  const dayKey = toIsoNow().slice(0, 10);
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

  if (!sweep || !catalog) {
    const sweepRunId = await registerSweepRun({
      name: runName,
      description: 'Auto daily incremental sync (empty source snapshot)',
      resultSummary: {
        source: 'research_scheduler',
        sourceTimestamp,
        emptySource: true,
        reason: 'No sweep/catalog data available (results files and DB fallback both empty)',
      },
      config: {
        source: 'research_scheduler',
        mode: 'daily_incremental_sync',
      },
    });

    return {
      status: 'done',
      details: {
        sweep_run_id: sweepRunId,
        imported: 0,
        skipped: 0,
        candidates: 0,
        emptySource: true,
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

  // Always refresh storefront snapshots after successful daily research sync.
  // Force mode guarantees alignment even if interval/settings would otherwise skip.
  try {
    const snapshotResult = await refreshOfferStoreSnapshotsFromSweep({
      force: true,
      reason: 'daily_sweep_auto',
      sweepTimestamp: String(sweep?.timestamp || ''),
    });
    logger.info(`[researchScheduler] Auto snapshot refresh: ok=${snapshotResult.ok}, skipped=${snapshotResult.skipped}, systems=${snapshotResult.systemsUpdated}`);
  } catch (err) {
    logger.error(`[researchScheduler] Auto snapshot refresh failed: ${(err as Error).message}`);
  }

  // Auto-sync strategy max_deposit from subscription plans
  try {
    const syncResult = await syncAllTenantStrategyMaxDeposit();
    logger.info(`[researchScheduler] Auto max_deposit sync: updated=${syncResult.updated}, checked=${syncResult.checked}, errors=${syncResult.errors.length}`);
  } catch (err) {
    logger.error(`[researchScheduler] Auto max_deposit sync failed: ${(err as Error).message}`);
  }

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

const parseDayKey = (value: string): Date | null => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    return null;
  }
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) ? date : null;
};

const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const listExistingDailySyncDays = async (): Promise<Set<string>> => {
  const researchDb = getResearchDb();
  const rows = await researchDb.all(
    `SELECT name
     FROM sweep_runs
     WHERE name LIKE 'daily_sync_%'
     ORDER BY id ASC`
  ) as Array<{ name?: string }>;

  const out = new Set<string>();
  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String(row?.name || '').trim();
    const day = name.startsWith('daily_sync_') ? name.slice('daily_sync_'.length) : '';
    if (parseDayKey(day)) {
      out.add(day);
    }
  }
  return out;
};

const runDailyIncrementalSweepForDay = async (
  dayKey: string,
  sweep: any,
  catalog: any
): Promise<{ status: SchedulerStatus; details: Record<string, unknown> }> => {
  const researchDb = getResearchDb();
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

  if (!sweep || !catalog) {
    const sweepRunId = await registerSweepRun({
      name: runName,
      description: `Auto daily incremental sync (empty source snapshot) for ${dayKey}`,
      resultSummary: {
        source: 'research_scheduler',
        dayKey,
        emptySource: true,
      },
      config: {
        source: 'research_scheduler',
        mode: 'daily_incremental_sync',
        dayKey,
      },
    });

    return {
      status: 'done',
      details: {
        sweep_run_id: sweepRunId,
        imported: 0,
        skipped: 0,
        candidates: 0,
        emptySource: true,
        dayKey,
      },
    };
  }

  const sweepRunId = await registerSweepRun({
    name: runName,
    description: `Auto daily incremental sync for ${dayKey}`,
    resultSummary: {
      source: 'research_scheduler',
      dayKey,
      sourceTimestamp: sweep?.timestamp || null,
      counts: sweep?.counts || {},
    },
    config: {
      source: 'research_scheduler',
      mode: 'daily_incremental_sync',
      dayKey,
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
        dayKey,
        sourceTimestamp: sweep?.timestamp || null,
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
      dayKey,
    },
  };
};

export const analyzeDailySweepGap = async (daysBack: number = 30): Promise<{
  fromDay: string;
  toDay: string;
  totalDays: number;
  existingDays: number;
  missingDays: string[];
}> => {
  const safeDaysBack = Math.max(1, Math.min(365, Math.floor(Number(daysBack) || 30)));
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const from = new Date(today);
  from.setUTCDate(from.getUTCDate() - safeDaysBack + 1);

  const existing = await listExistingDailySyncDays();
  const missingDays: string[] = [];

  let cursor = new Date(from);
  while (cursor.getTime() <= today.getTime()) {
    const dayKey = toDayKey(cursor);
    if (!existing.has(dayKey)) {
      missingDays.push(dayKey);
    }
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return {
    fromDay: toDayKey(from),
    toDay: toDayKey(today),
    totalDays: safeDaysBack,
    existingDays: safeDaysBack - missingDays.length,
    missingDays,
  };
};

export const runDailySweepGapBackfill = async (maxDays: number = 30, modeInput: unknown = 'light'): Promise<{
  analyzed: number;
  existingDays: number;
  missingDays: number;
  mode: SweepRunMode;
  requestedMaxDays: number;
  processedDays: number;
  createdRuns: number;
  createdDayKeys: string[];
  skippedDayKeys: string[];
}> => {
  const mode = normalizeSweepRunMode(modeInput);
  const requestedMaxDays = Math.max(1, Math.min(365, Math.floor(Number(maxDays) || 30)));
  const safeMaxDays = mode === 'heavy' ? requestedMaxDays : Math.min(requestedMaxDays, 7);
  const dayBatchLimit = mode === 'heavy' ? 365 : 3;
  const gap = await analyzeDailySweepGap(safeMaxDays);
  const missingDaysToProcess = gap.missingDays.slice(0, dayBatchLimit);
  const { sweep, catalog } = await loadCatalogAndSweepWithFallback();

  let createdRuns = 0;
  const createdDayKeys: string[] = [];
  const skippedDayKeys: string[] = [];

  for (const dayKey of missingDaysToProcess) {
    const result = await runDailyIncrementalSweepForDay(dayKey, sweep, catalog);
    if (result.status === 'done') {
      createdRuns += 1;
      createdDayKeys.push(dayKey);
    } else {
      skippedDayKeys.push(dayKey);
    }
  }

  return {
    analyzed: gap.totalDays,
    existingDays: gap.existingDays,
    missingDays: gap.missingDays.length,
    mode,
    requestedMaxDays,
    processedDays: missingDaysToProcess.length,
    createdRuns,
    createdDayKeys,
    skippedDayKeys,
  };
};

const getLatestBackfillJob = async (): Promise<BackfillJobRow | null> => {
  const researchDb = getResearchDb();
  const row = await researchDb.get(
    `SELECT *
     FROM research_backfill_jobs
     WHERE job_key = 'daily_incremental_sweep_backfill'
     ORDER BY id DESC
     LIMIT 1`
  ) as BackfillJobRow | undefined;

  return row || null;
};

const getBackfillJobById = async (jobId: number): Promise<BackfillJobRow | null> => {
  const researchDb = getResearchDb();
  const row = await researchDb.get(
    `SELECT *
     FROM research_backfill_jobs
     WHERE id = ?
     LIMIT 1`,
    [jobId]
  ) as BackfillJobRow | undefined;

  return row || null;
};

export const getDailySweepBackfillStatus = async (): Promise<Record<string, unknown>> => {
  const latest = await getLatestBackfillJob();
  if (!latest) {
    return { exists: false };
  }

  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(String(latest.details_json || '{}')) as Record<string, unknown>;
  } catch {
    details = {};
  }

  return {
    exists: true,
    ...latest,
    details,
    isRunning: latest.status === 'running',
  };
};

export const updateDailySweepBackfillMode = async (modeInput: unknown, jobIdInput?: unknown): Promise<Record<string, unknown>> => {
  const researchDb = getResearchDb();
  const mode = normalizeSweepRunMode(modeInput);
  const jobId = Number(jobIdInput || 0);
  const targetJob = jobId > 0 ? await getBackfillJobById(jobId) : await getLatestBackfillJob();

  if (!targetJob) {
    throw new Error('Backfill job not found');
  }

  if (targetJob.status !== 'running' && targetJob.status !== 'queued') {
    throw new Error(`Cannot change mode for backfill job in status=${targetJob.status}`);
  }

  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(String(targetJob.details_json || '{}')) as Record<string, unknown>;
  } catch {
    details = {};
  }

  await researchDb.run(
    `UPDATE research_backfill_jobs
     SET mode = ?,
         details_json = ?,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [
      mode,
      JSON.stringify({
        ...details,
        modeSwitchAt: toIsoNow(),
        modeSwitchTo: mode,
      }),
      targetJob.id,
    ]
  );

  logger.info(`[researchBackfill] job=${targetJob.id} mode switched to ${mode}`);
  return getDailySweepBackfillStatus();
};

export const startDailySweepGapBackfillJob = async (maxDays: number = 30, modeInput: unknown = 'light'): Promise<Record<string, unknown>> => {
  const researchDb = getResearchDb();
  const mode = normalizeSweepRunMode(modeInput);
  const requestedMaxDays = Math.max(1, Math.min(365, Math.floor(Number(maxDays) || 30)));

  const existingRunning = await researchDb.get(
    `SELECT id FROM research_backfill_jobs
     WHERE job_key = 'daily_incremental_sweep_backfill' AND status = 'running'
     ORDER BY id DESC LIMIT 1`
  ) as { id?: number } | undefined;

  if (existingRunning?.id) {
    return {
      started: false,
      reason: 'Backfill already running',
      jobId: Number(existingRunning.id),
    };
  }

  const safeMaxDays = mode === 'heavy' ? requestedMaxDays : Math.min(requestedMaxDays, 7);
  const dayBatchLimit = mode === 'heavy' ? 365 : 3;
  const gap = await analyzeDailySweepGap(safeMaxDays);
  const missingDaysToProcess = gap.missingDays.slice(0, dayBatchLimit);

  const insertResult = await researchDb.run(
    `INSERT INTO research_backfill_jobs (
      job_key, mode, status,
      requested_max_days, analyzed_days, missing_days,
      processed_days, created_runs, skipped_days,
      current_day_key, eta_seconds, progress_percent,
      details_json, error, started_at, updated_at
    ) VALUES (
      'daily_incremental_sweep_backfill', ?, 'running',
      ?, ?, ?,
      0, 0, 0,
      '', 0, 0,
      ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      mode,
      requestedMaxDays,
      gap.totalDays,
      gap.missingDays.length,
      JSON.stringify({
        mode,
        requestedMaxDays,
        safeMaxDays,
        dayBatchLimit,
        toProcess: missingDaysToProcess.length,
        pendingDays: missingDaysToProcess,
      }),
    ]
  );

  const jobId = Number(insertResult?.lastID || 0);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('Failed to create backfill job record');
  }

  runningBackfillJobId = jobId;

  void (async () => {
    const startedAt = Date.now();
    let createdRuns = 0;
    let skippedDays = 0;
    let processedDays = 0;

    try {
      const { sweep, catalog } = await loadCatalogAndSweepWithFallback();

      while (true) {
        const currentJob = await getBackfillJobById(jobId);
        if (!currentJob) {
          throw new Error(`Backfill job disappeared: ${jobId}`);
        }
        if (currentJob.status !== 'running') {
          break;
        }

        const currentMode = normalizeSweepRunMode(currentJob.mode);
        const currentRequestedMaxDays = Math.max(1, Math.min(365, Math.floor(Number(currentJob.requested_max_days) || requestedMaxDays)));
        const currentSafeMaxDays = currentMode === 'heavy'
          ? currentRequestedMaxDays
          : Math.min(currentRequestedMaxDays, 7);
        const currentGap = await analyzeDailySweepGap(currentSafeMaxDays);
        const pendingDays = currentGap.missingDays;

        if (pendingDays.length === 0) {
          await researchDb.run(
            `UPDATE research_backfill_jobs
             SET analyzed_days = ?,
                 missing_days = ?,
                 current_day_key = '',
                 eta_seconds = 0,
                 progress_percent = 100,
                 details_json = ?,
                 updated_at = CURRENT_TIMESTAMP
             WHERE id = ?`,
            [
              currentGap.totalDays,
              processedDays,
              JSON.stringify({
                lastDay: '',
                mode: currentMode,
                processedDays,
                remainingDays: 0,
                pendingDays: [],
              }),
              jobId,
            ]
          );
          break;
        }

        const dayKey = pendingDays[0];
        const result = await runDailyIncrementalSweepForDay(dayKey, sweep, catalog);

        if (result.status === 'done') {
          createdRuns += 1;
        } else {
          skippedDays += 1;
        }

        processedDays += 1;
        const elapsedSec = Math.max(1, Math.floor((Date.now() - startedAt) / 1000));
        const avgSecPerDay = elapsedSec / Math.max(1, processedDays);
        const refreshedGap = await analyzeDailySweepGap(currentSafeMaxDays);
        const remainDays = Math.max(0, refreshedGap.missingDays.length);
        const totalPlannedDays = Math.max(1, processedDays + remainDays);
        const etaSeconds = Math.max(0, Math.round(remainDays * avgSecPerDay));
        const progressPercent = Number(((processedDays / totalPlannedDays) * 100).toFixed(2));

        await researchDb.run(
          `UPDATE research_backfill_jobs
           SET mode = ?,
               analyzed_days = ?,
               missing_days = ?,
               processed_days = ?,
               created_runs = ?,
               skipped_days = ?,
               current_day_key = ?,
               eta_seconds = ?,
               progress_percent = ?,
               details_json = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [
            currentMode,
            refreshedGap.totalDays,
            processedDays + remainDays,
            processedDays,
            createdRuns,
            skippedDays,
            dayKey,
            etaSeconds,
            progressPercent,
            JSON.stringify({
              lastDay: dayKey,
              lastResult: result,
              mode: currentMode,
              elapsedSec,
              processedDays,
              remainingDays: remainDays,
              pendingDays: refreshedGap.missingDays,
            }),
            jobId,
          ]
        );

        logger.info(`[researchBackfill] job=${jobId} mode=${currentMode} processed=${processedDays}/${totalPlannedDays} day=${dayKey} etaSec=${etaSeconds}`);

        await delay(currentMode === 'heavy' ? 100 : 1200);
      }

      await researchDb.run(
        `UPDATE research_backfill_jobs
         SET status = 'done',
             processed_days = ?,
             created_runs = ?,
             skipped_days = ?,
             current_day_key = '',
             eta_seconds = 0,
             progress_percent = 100,
             updated_at = CURRENT_TIMESTAMP,
             finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [processedDays, createdRuns, skippedDays, jobId]
      );
      logger.info(`[researchBackfill] job=${jobId} done mode=${mode} created=${createdRuns} skipped=${skippedDays}`);
    } catch (error) {
      const message = (error as Error).message;
      await researchDb.run(
        `UPDATE research_backfill_jobs
         SET status = 'failed',
             error = ?,
             eta_seconds = 0,
             updated_at = CURRENT_TIMESTAMP,
             finished_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [message, jobId]
      ).catch(() => {
        // Keep process resilient if DB update fails during fatal path.
      });
      logger.error(`[researchBackfill] job=${jobId} failed: ${message}`);
    } finally {
      if (runningBackfillJobId === jobId) {
        runningBackfillJobId = null;
      }
    }
  })();

  return {
    started: true,
    jobId,
    mode,
    requestedMaxDays,
    analyzed: gap.totalDays,
    missingDays: gap.missingDays.length,
    toProcess: missingDaysToProcess.length,
  };
};

const runSchedulerJobByKey = async (jobKey: SchedulerJobKey): Promise<{ status: SchedulerStatus; details: Record<string, unknown> }> => {
  if (jobKey === 'daily_incremental_sweep') {
    return runDailyIncrementalSweep();
  }

  if (jobKey === 'bt_rt_daily_snapshot') {
    const result = await runBtRtDailySweep();
    return {
      status: 'done',
      details: {
        date: result.date,
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
      },
    };
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
    // Store skip reason so the UI can show it instead of silent "skipped"
    const skipReason = result.status === 'skipped'
      ? String(result.details?.reason || 'Skipped: unknown reason')
      : '';
    await db.run(
      `UPDATE research_scheduler_jobs
       SET last_status = ?,
           last_error = ?,
           run_count = run_count + 1,
           next_run_at = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE job_key = ?`,
      [result.status, skipReason, computeNextDailyRunAtUtc(hourUtc, minuteUtc), jobKey]
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

const parseUtcMs = (value: unknown): number | null => {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : null;
};

export const getResearchDbObservability = async (): Promise<Record<string, unknown>> => {
  const researchDb = getResearchDb();
  const nowIso = toIsoNow();
  const nowMs = Date.parse(nowIso);

  const researchTables = [
    'strategy_profiles',
    'sweep_runs',
    'sweep_artifacts',
    'research_sweep_tasks',
    'preview_jobs',
    'client_presets',
    'publish_log',
    'backtest_runs',
    'research_scheduler_jobs',
    'research_backfill_jobs',
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
    'strategy_backtest_pair_requests',
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

  const latestSweep = await researchDb.get(
    `SELECT id, name, status, COALESCE(completed_at, created_at) AS sweep_at_utc
     FROM sweep_runs
     ORDER BY id DESC
     LIMIT 1`
  ) as { id?: number; name?: string; status?: string; sweep_at_utc?: string | null } | undefined;

  const sweepAtMs = parseUtcMs(latestSweep?.sweep_at_utc || null);
  const sweepLagHours = sweepAtMs !== null
    ? Number(((nowMs - sweepAtMs) / 3_600_000).toFixed(2))
    : null;

  const schedulerSnapshot = await researchDb.get(
    `SELECT job_key, is_enabled, last_status, last_run_at, next_run_at, run_count, last_error
     FROM research_scheduler_jobs
     WHERE job_key = 'daily_incremental_sweep'
     LIMIT 1`
  ) as Record<string, unknown> | undefined;

  const totalMainRows = Object.values(mainCounts).reduce<number>((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);
  const totalResearchRows = Object.values(researchCounts).reduce<number>((acc, v) => acc + (typeof v === 'number' ? v : 0), 0);

  return {
    atUtc: nowIso,
    files: {
      mainDb: fileInfo(getDbFilePath()),
      researchDb: fileInfo(getResearchDbFilePath()),
    },
    rowCounts: {
      main: mainCounts,
      research: researchCounts,
      totals: {
        main: totalMainRows,
        research: totalResearchRows,
      },
    },
    freshness: {
      latestSweep: latestSweep || null,
      latestSweepLagHours: sweepLagHours,
      scheduler: schedulerSnapshot || null,
    },
  };
};

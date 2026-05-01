/*
 * Standalone worker entry for the full historical sweep.
 *
 * Spawned by `startFullHistoricalSweepJob` via `child_process.fork` so that
 * the heavy CPU + network I/O of the sweep does NOT block the main API
 * event loop. The worker reuses the existing `processJob` implementation
 * unchanged: it loads the job's config from the `research_backfill_jobs`
 * row created by the API, then runs the same loop. Existing graceful
 * abort (DB-poll every 5s + log-resume) keeps working without any extra
 * IPC: setting status='failed' on the DB row makes the worker stop.
 *
 * Argv: node sweepWorkerEntry.js <jobId>
 */
import { initResearchDb, getResearchDb } from './db';
import { processJob } from './fullHistoricalSweepService';
import logger from '../utils/logger';

type JobRow = {
  mode?: string;
  details_json?: string;
};

const main = async (): Promise<void> => {
  const jobId = Number(process.argv[2]);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    console.error('[sweep-worker] missing or invalid jobId argv');
    process.exit(2);
  }

  await initResearchDb();
  const db = getResearchDb();
  const row = (await db.get(
    `SELECT mode, details_json FROM research_backfill_jobs WHERE id = ? LIMIT 1`,
    [jobId]
  )) as JobRow | undefined;

  if (!row) {
    console.error(`[sweep-worker] job ${jobId} not found`);
    process.exit(3);
  }

  let parsed: { config?: unknown } = {};
  try {
    parsed = JSON.parse(String(row.details_json || '{}'));
  } catch (e) {
    console.error(`[sweep-worker] failed to parse details_json for job ${jobId}: ${(e as Error).message}`);
    process.exit(4);
  }

  const config = parsed?.config;
  if (!config || typeof config !== 'object') {
    console.error(`[sweep-worker] job ${jobId} has no config in details_json`);
    process.exit(5);
  }

  const mode = (String(row.mode || 'heavy').toLowerCase() === 'light' ? 'light' : 'heavy') as 'light' | 'heavy';

  const onSignal = (signal: string) => {
    logger.info(`[sweep-worker] job=${jobId} received ${signal}; relying on DB-poll abort to stop gracefully`);
  };
  process.on('SIGTERM', () => onSignal('SIGTERM'));
  process.on('SIGINT', () => onSignal('SIGINT'));
  process.on('SIGHUP', () => onSignal('SIGHUP'));

  logger.info(`[sweep-worker] job=${jobId} mode=${mode} starting`);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await processJob(jobId, config as any, mode);
  logger.info(`[sweep-worker] job=${jobId} done`);
  process.exit(0);
};

main().catch((err) => {
  console.error('[sweep-worker] fatal:', (err as Error).stack || err);
  process.exit(1);
});

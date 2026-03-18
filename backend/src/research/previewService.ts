/**
 * Preview service: manages the preview_jobs queue in research.db.
 *
 * The preview worker polls this table, executes lightweight KPI computation
 * (reusing the existing backtest engine), and stores results.
 */
import crypto from 'crypto';
import { getResearchDb } from './db';
import logger from '../utils/logger';

export type PreviewJobStatus = 'queued' | 'running' | 'done' | 'failed';

export type PreviewJob = {
  id: number;
  profile_id: number | null;
  config_json: string;
  config_hash: string;
  status: PreviewJobStatus;
  priority: number;
  result_json: string | null;
  error: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
};

export type PreviewMetrics = {
  ret: number;
  pf: number;
  dd: number;
  wr: number;
  sharpe: number;
  trades: number;
  equity_curve: number[];
};

const hashConfig = (config: Record<string, unknown>): string =>
  crypto.createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 32);

const PREVIEW_DEDUP_MINUTES = 5;

/**
 * Enqueue a preview job for a given config.
 * Deduplicates: if same config_hash was computed within PREVIEW_DEDUP_MINUTES, return cached.
 *
 * priority: 10 = high (client-triggered), 0 = low (background)
 */
export const enqueuePreviewJob = async (
  config: Record<string, unknown>,
  options?: { profile_id?: number; priority?: number }
): Promise<{ jobId: number; cached: boolean; status: PreviewJobStatus }> => {
  const db = getResearchDb();
  const hash = hashConfig(config);
  const priority = options?.priority ?? 0;

  // Check recent done result (within PREVIEW_DEDUP_MINUTES)
  const cutoff = new Date(Date.now() - PREVIEW_DEDUP_MINUTES * 60 * 1000).toISOString();
  const existing = await db.get(
    `SELECT id, status FROM preview_jobs
     WHERE config_hash = ? AND status = 'done' AND created_at > ?
     ORDER BY created_at DESC LIMIT 1`,
    [hash, cutoff]
  );
  if (existing) {
    return { jobId: Number(existing.id), cached: true, status: 'done' };
  }

  // Check if already queued or running
  const inFlight = await db.get(
    `SELECT id, status FROM preview_jobs
     WHERE config_hash = ? AND status IN ('queued', 'running')
     ORDER BY created_at DESC LIMIT 1`,
    [hash]
  );
  if (inFlight) {
    return { jobId: Number(inFlight.id), cached: false, status: inFlight.status as PreviewJobStatus };
  }

  const result = await db.run(
    `INSERT INTO preview_jobs (profile_id, config_json, config_hash, status, priority, created_at)
     VALUES (?, ?, ?, 'queued', ?, CURRENT_TIMESTAMP)`,
    [options?.profile_id ?? null, JSON.stringify(config), hash, priority]
  );
  const jobId = Number(result?.lastID);
  if (!jobId) {
    throw new Error('Failed to create preview job');
  }

  return { jobId, cached: false, status: 'queued' };
};

export const getPreviewJob = async (jobId: number): Promise<PreviewJob | null> => {
  const db = getResearchDb();
  const row = await db.get('SELECT * FROM preview_jobs WHERE id = ?', [jobId]);
  return (row || null) as PreviewJob | null;
};

export const getPreviewResult = async (jobId: number): Promise<PreviewMetrics | null> => {
  const job = await getPreviewJob(jobId);
  if (!job || job.status !== 'done' || !job.result_json) {
    return null;
  }
  try {
    return JSON.parse(job.result_json) as PreviewMetrics;
  } catch {
    return null;
  }
};

/** Called by preview worker: claim the next queued job. */
export const claimNextPreviewJob = async (): Promise<PreviewJob | null> => {
  const db = getResearchDb();
  const row = await db.get(
    `SELECT * FROM preview_jobs
     WHERE status = 'queued'
     ORDER BY priority DESC, created_at ASC
     LIMIT 1`
  );
  if (!row) {
    return null;
  }

  await db.run(
    `UPDATE preview_jobs SET status = 'running', started_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [row.id]
  );

  return { ...row, status: 'running' } as PreviewJob;
};

/** Called by preview worker: mark job done with result. */
export const completePreviewJob = async (
  jobId: number,
  result: PreviewMetrics
): Promise<void> => {
  const db = getResearchDb();
  await db.run(
    `UPDATE preview_jobs
     SET status = 'done', result_json = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [JSON.stringify(result), jobId]
  );

  logger.info(`Preview job #${jobId} completed`);
};

/** Called by preview worker: mark job failed. */
export const failPreviewJob = async (jobId: number, error: string): Promise<void> => {
  const db = getResearchDb();
  await db.run(
    `UPDATE preview_jobs
     SET status = 'failed', error = ?, completed_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [error, jobId]
  );

  logger.warn(`Preview job #${jobId} failed: ${error}`);
};

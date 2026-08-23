import { spawn } from 'child_process';
import path from 'path';
import logger from '../utils/logger';
import { getDbFilePath } from '../utils/database';

const RETENTION_INTERVAL_MS = Math.max(
  6 * 3600_000,
  Number(process.env.DB_RETENTION_INTERVAL_HOURS || 168) * 3600_000,
);

let retentionRunning = false;
let lastRetentionAt = 0;

export const runDbRetentionCleanup = async (options?: {
  dryRun?: boolean;
  vacuum?: boolean;
}): Promise<{ ok: boolean; code: number | null }> => {
  const repoRoot = path.resolve(__dirname, '../../..');
  const scriptPath = path.join(repoRoot, 'scripts/admin_tools/db_retention_cleanup.py');
  const dbPath = getDbFilePath();
  const dryRun = options?.dryRun === true;
  const vacuum = options?.vacuum === true && !dryRun;

  return new Promise((resolve) => {
    const purgeOrphans = String(process.env.DB_RETENTION_PURGE_ORPHANS || '0').trim() === '1';
    const args = [
      scriptPath,
      dryRun ? '--dry-run' : '--apply',
      ...(vacuum ? ['--vacuum'] : []),
      ...(purgeOrphans && !dryRun ? ['--purge-orphans'] : []),
    ];
    const child = spawn('python3', args, {
      env: {
        ...process.env,
        DB_PATH: dbPath,
        RETENTION_DAYS: process.env.DB_RETENTION_DAYS || '90',
        PINNED_BACKTEST_RUN_IDS: process.env.PINNED_BACKTEST_RUN_IDS || '360',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let out = '';
    child.stdout?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      out += String(chunk);
    });
    child.on('close', (code) => {
      const text = out.trim();
      if (text) {
        logger.info(`[db-retention] ${text.split('\n').slice(-8).join(' | ')}`);
      }
      resolve({ ok: code === 0, code });
    });
    child.on('error', (err) => {
      logger.warn(`[db-retention] spawn failed: ${(err as Error).message}`);
      resolve({ ok: false, code: null });
    });
  });
};

/** Weekly auto-retention (strip blobs, no VACUUM — VACUUM is maintenance-window only). */
export const startDbRetentionScheduler = (): void => {
  const enabled = String(process.env.DB_RETENTION_AUTO || '1').trim() !== '0';
  if (!enabled) {
    logger.info('[db-retention] Auto retention disabled (DB_RETENTION_AUTO=0)');
    return;
  }

  const tick = async () => {
    if (retentionRunning) return;
    if (Date.now() - lastRetentionAt < RETENTION_INTERVAL_MS - 60_000) return;
    retentionRunning = true;
    try {
      const result = await runDbRetentionCleanup({ dryRun: false, vacuum: false });
      if (result.ok) {
        lastRetentionAt = Date.now();
      }
    } catch (e) {
      logger.warn(`[db-retention] cycle error: ${(e as Error).message}`);
    } finally {
      retentionRunning = false;
    }
  };

  // First run after warm-up (10 min) so boot is not blocked on 21GB scan
  setTimeout(() => void tick(), 10 * 60_000);
  setInterval(() => void tick(), RETENTION_INTERVAL_MS);
  logger.info(
    `[db-retention] Scheduler started (every ${Math.round(RETENTION_INTERVAL_MS / 3600_000)}h, vacuum=manual)`,
  );
};

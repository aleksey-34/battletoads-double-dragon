/**
 * BTDD Research Process — контур исследований.
 *
 * Запускается как отдельный systemd-сервис (btdd-research.service).
 * Не поднимает HTTP-сервер. Только research workers:
 *   - startPreviewWorker   — фоновый счёт KPI для preview_jobs
 *   - startResearchSchedulerWorker — daily incremental sweep sync
 *
 * Зависит от главной БД (main.db) и research.db.
 */

import { initDB, getDbFilePath } from './utils/database';
import { initResearchDb } from './research/db';
import logger from './utils/logger';
import { startPreviewWorker, stopPreviewWorker } from './workers/previewWorker';
import { startResearchSchedulerWorker, stopResearchSchedulerWorker } from './workers/researchSchedulerWorker';

const startResearch = async () => {
  await initDB();
  logger.info(`[research] Main DB initialized: ${getDbFilePath()}`);

  await initResearchDb();
  logger.info('[research] Research DB initialized');

  void startPreviewWorker();
  logger.info('[research] Preview worker started');

  void startResearchSchedulerWorker();
  logger.info('[research] Research scheduler worker started');

  logger.info('[research] Research process started — контур исследований активен');
};

// ── Graceful shutdown ────────────────────────────────────────────────────────
const shutdown = async (signal: string) => {
  logger.info(`[research] Received ${signal} — shutting down gracefully`);
  stopResearchSchedulerWorker();
  stopPreviewWorker();
  process.exit(0);
};

process.on('SIGTERM', () => { void shutdown('SIGTERM'); });
process.on('SIGINT', () => { void shutdown('SIGINT'); });

startResearch().catch((err) => {
  logger.error('[research] Fatal startup error: ' + (err as Error).message);
  process.exit(1);
});

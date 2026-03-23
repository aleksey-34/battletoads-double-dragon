import logger from '../utils/logger';
import { ensureDefaultSchedulerJobs, runDueResearchSchedulerJobs } from '../research/schedulerService';

const POLL_INTERVAL_MS = 60_000;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;

const tick = async (): Promise<void> => {
  try {
    await ensureDefaultSchedulerJobs();
    const results = await runDueResearchSchedulerJobs(1);
    for (const item of results) {
      logger.info(`[researchScheduler] job=${item.job_key} status=${item.status}`);
    }
  } catch (error) {
    logger.error(`[researchScheduler] tick error: ${(error as Error).message}`);
  }
};

const schedule = (): void => {
  timer = setTimeout(async () => {
    await tick();
    if (started) {
      schedule();
    }
  }, POLL_INTERVAL_MS);
};

export const startResearchSchedulerWorker = async (): Promise<void> => {
  if (started) {
    return;
  }
  started = true;
  logger.info(`[researchScheduler] started polling every ${POLL_INTERVAL_MS}ms`);
  await tick();
  schedule();
};

export const stopResearchSchedulerWorker = (): void => {
  started = false;
  if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  logger.info('[researchScheduler] stopped');
};

/**
 * Preview Worker
 *
 * Polls the research DB preview_jobs queue every POLL_INTERVAL_MS and executes
 * lightweight backtest previews for strategy profiles.
 *
 * Safe to run inside the same Node process as the trading server.
 * Max MAX_CONCURRENT jobs can run in parallel; each has a hard timeout.
 *
 * The config_json stored in preview_jobs must match BacktestRunRequest:
 *   { apiKeyName, strategyId, bars?, dateFrom?, dateTo?, initialBalance?, ... }
 *
 * The preview does NOT create a runtime strategy — it uses an existing
 * runtime strategy (by strategyId) or a temporarily registered transient
 * strategy. To safeguard the trading engine this file NEVER writes to the
 * runtime strategies table during execution.
 */
import { initResearchDb } from '../research/db';
import {
  claimNextPreviewJob,
  completePreviewJob,
  failPreviewJob,
} from '../research/previewService';
import { runBacktest, BacktestRunRequest } from '../backtest/engine';
import logger from '../utils/logger';

const POLL_INTERVAL_MS = 5_000;
const MAX_CONCURRENT = 3;
const JOB_TIMEOUT_MS = 120_000;

let activeCount = 0;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

// ─── Execution ────────────────────────────────────────────────────────────────

const executeJob = async (jobId: number, configJson: string): Promise<void> => {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(configJson) as Record<string, unknown>;
  } catch {
    throw new Error('preview job config_json is not valid JSON');
  }

  const request: BacktestRunRequest = {
    apiKeyName: String(config.apiKeyName ?? ''),
    mode: config.mode as 'single' | 'portfolio' | undefined,
    strategyId: config.strategyId != null ? Number(config.strategyId) : undefined,
    strategyIds: Array.isArray(config.strategyIds) ? (config.strategyIds as number[]) : undefined,
    bars: config.bars != null ? Number(config.bars) : 500,
    dateFrom: config.dateFrom as string | undefined,
    dateTo: config.dateTo as string | undefined,
    warmupBars: config.warmupBars != null ? Number(config.warmupBars) : 0,
    initialBalance: config.initialBalance != null ? Number(config.initialBalance) : 1000,
    commissionPercent: config.commissionPercent != null ? Number(config.commissionPercent) : 0.06,
    slippagePercent: config.slippagePercent != null ? Number(config.slippagePercent) : 0.03,
    skipMissingSymbols: config.skipMissingSymbols === true,
  };

  if (!request.apiKeyName) {
    throw new Error('preview config must include apiKeyName');
  }
  if (!request.strategyId && (!request.strategyIds || request.strategyIds.length === 0)) {
    throw new Error('preview config must include strategyId or strategyIds[]');
  }

  const result = await runBacktest(request);
  const { summary, equityCurve } = result;

  return completePreviewJob(jobId, {
    ret: summary.totalReturnPercent,
    pf: summary.profitFactor,
    dd: summary.maxDrawdownPercent,
    wr: summary.winRatePercent,
    sharpe: 0, // engine does not compute Sharpe yet
    trades: summary.tradesCount,
    equity_curve: equityCurve.map((p) => p.equity),
  });
};

// ─── Poll loop ────────────────────────────────────────────────────────────────

const runWithTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
  Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`Preview job timed out after ${ms}ms`)), ms)
    ),
  ]);

const processBatch = async (): Promise<void> => {
  if (activeCount >= MAX_CONCURRENT) {
    return;
  }

  let job = await claimNextPreviewJob();
  while (job && activeCount < MAX_CONCURRENT) {
    const { id, config_json } = job;
    activeCount += 1;
    logger.info(`[previewWorker] Starting job #${id} (active=${activeCount})`);

    runWithTimeout(executeJob(id, config_json), JOB_TIMEOUT_MS)
      .catch((err: Error) => {
        logger.error(`[previewWorker] Job #${id} failed: ${err.message}`);
        return failPreviewJob(id, err.message);
      })
      .finally(() => {
        activeCount -= 1;
        logger.info(`[previewWorker] Job #${id} done (active=${activeCount})`);
      });

    job = activeCount < MAX_CONCURRENT ? await claimNextPreviewJob() : null;
  }
};

const schedulePoll = (): void => {
  pollTimer = setTimeout(async () => {
    try {
      await processBatch();
    } catch (err) {
      logger.error(`[previewWorker] Poll error: ${(err as Error).message}`);
    }
    if (started) {
      schedulePoll();
    }
  }, POLL_INTERVAL_MS);
};

// ─── Public API ───────────────────────────────────────────────────────────────

export const startPreviewWorker = async (): Promise<void> => {
  if (started) {
    return;
  }
  await initResearchDb();
  started = true;
  logger.info(`[previewWorker] Started — polling every ${POLL_INTERVAL_MS}ms, max ${MAX_CONCURRENT} concurrent`);
  schedulePoll();
};

export const stopPreviewWorker = (): void => {
  started = false;
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
  logger.info('[previewWorker] Stopped');
};

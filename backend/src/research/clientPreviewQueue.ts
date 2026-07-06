/**
 * Client-facing backtest preview queue (research.db preview_jobs).
 * Offloads heavy runBacktest from API request thread.
 */
import { initResearchDb } from './db';
import {
  enqueuePreviewJob,
  getPreviewJob,
  getPreviewResult,
  type PreviewJobStatus,
  type PreviewMetrics,
} from './previewService';

export type ClientPreviewKind = 'single' | 'portfolio';

export type ClientPreviewQueueInput = {
  tenantId: number;
  apiKeyName: string;
  kind: ClientPreviewKind;
  strategyId?: number;
  strategyIds?: number[];
  bars?: number;
  warmupBars?: number;
  initialBalance?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
  skipMissingSymbols?: boolean;
  maxDepositOverride?: number;
  lotPercentOverride?: number;
};

export type ClientPreviewQueueResponse = {
  jobId: number;
  status: PreviewJobStatus;
  cached: boolean;
};

const buildJobConfig = (input: ClientPreviewQueueInput): Record<string, unknown> => ({
  source: 'client_preview',
  tenantId: input.tenantId,
  apiKeyName: input.apiKeyName,
  mode: input.kind === 'portfolio' ? 'portfolio' : 'single',
  strategyId: input.strategyId,
  strategyIds: input.strategyIds,
  bars: input.bars ?? 500,
  warmupBars: input.warmupBars ?? 0,
  initialBalance: input.initialBalance ?? 1000,
  commissionPercent: input.commissionPercent ?? 0.1,
  slippagePercent: input.slippagePercent ?? 0.05,
  fundingRatePercent: input.fundingRatePercent ?? 0,
  skipMissingSymbols: input.skipMissingSymbols !== false,
  maxDepositOverride: input.maxDepositOverride,
  lotPercentOverride: input.lotPercentOverride,
});

export const enqueueClientPreview = async (
  input: ClientPreviewQueueInput,
): Promise<ClientPreviewQueueResponse> => {
  await initResearchDb();
  const { jobId, cached, status } = await enqueuePreviewJob(buildJobConfig(input), {
    priority: 10,
  });
  return { jobId, status, cached };
};

export const getClientPreviewJobForTenant = async (
  tenantId: number,
  jobId: number,
) => {
  await initResearchDb();
  const job = await getPreviewJob(jobId);
  if (!job) {
    return null;
  }

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(job.config_json) as Record<string, unknown>;
  } catch {
    return null;
  }

  if (Number(config.tenantId) !== tenantId) {
    return null;
  }

  return job;
};

export const metricsToClientPreview = (metrics: PreviewMetrics) => ({
  summary: {
    totalReturnPercent: metrics.ret,
    maxDrawdownPercent: metrics.dd,
    winRatePercent: metrics.wr,
    profitFactor: metrics.pf,
    tradesCount: metrics.trades,
    finalEquity: metrics.equity_curve.length > 0
      ? metrics.equity_curve[metrics.equity_curve.length - 1]
      : undefined,
  },
  equity: metrics.equity_curve.map((equity, index) => ({ index, equity })),
});

export const getClientPreviewJobPayload = async (tenantId: number, jobId: number) => {
  const job = await getClientPreviewJobForTenant(tenantId, jobId);
  if (!job) {
    return null;
  }

  const metrics = job.status === 'done' ? await getPreviewResult(jobId) : null;

  return {
    jobId,
    status: job.status as PreviewJobStatus,
    error: job.error,
    preview: metrics ? {
      source: 'queued_backtest',
      ...metricsToClientPreview(metrics),
      trades: [],
    } : null,
  };
};

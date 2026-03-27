import fs from 'fs';
import path from 'path';
import { runBacktest } from '../backtest/engine';
import { ensureExchangeClientInitialized } from '../bot/exchange';
import { createStrategy, getStrategies, updateStrategy } from '../bot/strategy';
import { Strategy } from '../config/settings';
import { initResearchDb, getResearchDb } from './db';
import { initDB } from '../utils/database';
import logger from '../utils/logger';
import { buildClientCatalogFromSweepData, CatalogData, SweepData, SweepRecord } from '../saas/service';
import { importHistoricalArtifactsToResearch } from './importService';

type SweepMode = 'light' | 'heavy';
type JobStatus = 'queued' | 'running' | 'done' | 'failed';

type HistoricalSweepConfig = {
  apiKeyName: string;
  dateFrom: string;
  dateTo: string | null;
  interval: string;
  intervals: string[];
  backtestBars: number;
  warmupBars: number;
  skipMissingSymbols: boolean;
  initialBalance: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
  maxRuns: number;
  maxVariantsPerMarketType: number;
  exhaustiveMode: boolean;
  turboMode: boolean;
  resumeEnabled: boolean;
  checkpointEvery: number;
  checkpointFile: string;
  updateExistingStrategies: boolean;
  windowBacktestsEnabled: boolean;
  allowDuplicateMarkets: boolean;
  maxMembers: number;
  robust: {
    minProfitFactor: number;
    maxDrawdownPercent: number;
    minTrades: number;
  };
  strategyTypes: Array<'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout'>;
  monoMarkets: string[];
  synthMarkets: string[];
  ddLengths: number[];
  ddTakeProfits: number[];
  ddSources: Array<'close' | 'wick'>;
  statLengths: number[];
  statEntry: number[];
  statExit: number[];
  statStop: number[];
  systemName: string;
  strategyPrefix: string;
};

type SweepRunPlan = {
  key: string;
  index: number;
  strategyType: 'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout';
  marketMode: 'mono' | 'synth';
  market: string;
  baseSymbol: string;
  quoteSymbol: string;
  interval: string;
  length: number;
  takeProfitPercent: number;
  detectionSource: 'close' | 'wick';
  zscoreEntry: number;
  zscoreExit: number;
  zscoreStop: number;
  strategyName: string;
};

type SweepFailure = {
  runIndex: number;
  key: string;
  strategyName: string;
  strategyType: string;
  marketMode: string;
  market: string;
  error: string;
};

type SweepRecordInternal = SweepRecord & {
  strategyIdResolved: boolean;
  created: boolean;
  finalEquity: number;
  runIndex: number;
  restoredFromLog: boolean;
};

type SweepCheckpoint = {
  config: HistoricalSweepConfig;
  startedAt: string;
  evaluated: SweepRecordInternal[];
  failures: SweepFailure[];
};

const repoRoot = path.resolve(__dirname, '../../..');
const resultsDir = path.join(repoRoot, 'results');
const defaultMonoMarkets = ['BERAUSDT', 'IPUSDT', 'ORDIUSDT', 'GRTUSDT', 'INJUSDT', 'TRUUSDT', 'STXUSDT', 'VETUSDT', 'AUCTIONUSDT', 'MERLUSDT', 'ZECUSDT', 'SOMIUSDT'];
const defaultSynthMarkets = ['IPUSDT/ZECUSDT', 'ORDIUSDT/ZECUSDT', 'MERLUSDT/SOMIUSDT', 'AUCTIONUSDT/MERLUSDT', 'BERAUSDT/ZECUSDT', 'IPUSDT/SOMIUSDT', 'GRTUSDT/INJUSDT', 'TRUUSDT/GRTUSDT', 'STXUSDT/INJUSDT', 'VETUSDT/GRTUSDT'];

const defaultDdLengths = [5, 8, 12, 16, 24, 36];
const defaultDdTakeProfits = [2, 3, 4, 5, 7.5, 10];
const defaultDdSources: Array<'close' | 'wick'> = ['close', 'wick'];
const defaultStatLengths = [24, 36, 48, 72, 96, 120];
const defaultStatEntry = [1.25, 1.5, 1.75, 2, 2.25];
const defaultStatExit = [0.5, 0.75, 1];
const defaultStatStop = [2.5, 3, 3.5];

const activeJobs = new Set<number>();

const ensureResultsDir = (): void => {
  fs.mkdirSync(resultsDir, { recursive: true });
};

const toIsoSafe = (value: Date = new Date()): string => value.toISOString().replace(/[:.]/g, '-');

const formatMetricToken = (value: number): string => String(value).replace(/\.0+$/, '').replace('.', '_');

const parseMarket = (market: string): { baseSymbol: string; quoteSymbol: string } => {
  const text = String(market || '').trim().toUpperCase();
  if (text.includes('/')) {
    const [baseSymbol, quoteSymbol] = text.split('/');
    return {
      baseSymbol: String(baseSymbol || '').trim().toUpperCase(),
      quoteSymbol: String(quoteSymbol || '').trim().toUpperCase(),
    };
  }
  return {
    baseSymbol: text,
    quoteSymbol: '',
  };
};

const normalizeMode = (value: unknown): SweepMode => String(value || '').trim().toLowerCase() === 'light' ? 'light' : 'heavy';

const parseIntervals = (raw: unknown): string[] => {
  const text = String(raw || '').trim();
  if (!text) {
    return ['4h'];
  }

  const parts = text
    .split(/[\s,;|]+/)
    .map((item) => String(item || '').trim())
    .filter(Boolean);

  const normalized = Array.from(new Set(parts));
  const valid = normalized.filter((value) => /^\d+(m|h|d|w|M)$/i.test(value));
  return valid.length > 0 ? valid : ['4h'];
};

const parseStringList = (raw: unknown): string[] => {
  if (Array.isArray(raw)) {
    return Array.from(new Set(raw.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)));
  }
  const text = String(raw || '').trim();
  if (!text) {
    return [];
  }
  return Array.from(new Set(text.split(/[\s,;|]+/).map((item) => item.trim().toUpperCase()).filter(Boolean)));
};

const parseNumberList = (raw: unknown): number[] => {
  const values = Array.isArray(raw)
    ? raw
    : String(raw || '').split(/[\s,;|]+/).filter(Boolean);
  const normalized = values
    .map((item) => Number(item))
    .filter((value) => Number.isFinite(value));
  return Array.from(new Set(normalized));
};

const parseStrategyTypes = (raw: unknown): Array<'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout'> => {
  const values = parseStringList(raw);
  const allowed = new Set(['DD_BATTLETOADS', 'STAT_ARB_ZSCORE', 'ZZ_BREAKOUT']);
  const parsed = values
    .filter((value) => allowed.has(value))
    .map((value) => {
      if (value === 'DD_BATTLETOADS') {
        return 'DD_BattleToads';
      }
      if (value === 'ZZ_BREAKOUT') {
        return 'zz_breakout';
      }
      return 'stat_arb_zscore';
    });
  return parsed;
};

const parseDdSources = (raw: unknown): Array<'close' | 'wick'> => {
  const values = Array.isArray(raw)
    ? raw.map((item) => String(item || '').trim().toLowerCase())
    : String(raw || '').split(/[\s,;|]+/).map((item) => item.trim().toLowerCase());
  const parsed = Array.from(new Set(values.filter((item) => item === 'close' || item === 'wick'))) as Array<'close' | 'wick'>;
  return parsed;
};

const buildDefaultConfig = (input?: Partial<HistoricalSweepConfig> & { mode?: unknown }): HistoricalSweepConfig => {
  const apiKeyName = String(input?.apiKeyName || 'BTDD_D1').trim() || 'BTDD_D1';
  const dateFrom = String(input?.dateFrom || '2025-01-01T00:00:00Z').trim() || '2025-01-01T00:00:00Z';
  const dateTo = input?.dateTo ? String(input.dateTo).trim() : null;
  const intervals = parseIntervals(input?.interval || (input as any)?.intervals || '4h');
  const interval = intervals[0] || '4h';
  const safePrefix = String(input?.strategyPrefix || 'HISTSWEEP').trim() || 'HISTSWEEP';
  const safeSystemName = String(input?.systemName || `${safePrefix} ${apiKeyName} Candidate`).trim() || `${safePrefix} ${apiKeyName} Candidate`;
  const checkpointFile = input?.checkpointFile
    ? String(input.checkpointFile)
    : path.join(resultsDir, `${apiKeyName.toLowerCase()}_historical_sweep_checkpoint.json`);
  const hasMonoMarkets = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'monoMarkets'));
  const hasSynthMarkets = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'synthMarkets'));
  const parsedMonoMarkets = parseStringList((input as any)?.monoMarkets);
  const parsedSynthMarkets = parseStringList((input as any)?.synthMarkets);

  return {
    apiKeyName,
    dateFrom,
    dateTo,
    interval,
    intervals,
    backtestBars: Math.max(120, Number(input?.backtestBars || 6000)),
    warmupBars: Math.max(0, Number(input?.warmupBars || 400)),
    skipMissingSymbols: input?.skipMissingSymbols !== false,
    initialBalance: Math.max(100, Number(input?.initialBalance || 10000)),
    commissionPercent: Number(input?.commissionPercent ?? 0.1),
    slippagePercent: Number(input?.slippagePercent ?? 0.05),
    fundingRatePercent: Number(input?.fundingRatePercent ?? 0),
    maxRuns: Math.max(1, Number(input?.maxRuns || Number.MAX_SAFE_INTEGER)),
    maxVariantsPerMarketType: Math.max(1, Number(input?.maxVariantsPerMarketType || 8)),
    exhaustiveMode: input?.exhaustiveMode !== false,
    turboMode: input?.turboMode !== false,
    resumeEnabled: input?.resumeEnabled !== false,
    checkpointEvery: Math.max(1, Number(input?.checkpointEvery || 25)),
    checkpointFile,
    updateExistingStrategies: input?.updateExistingStrategies === true,
    windowBacktestsEnabled: input?.windowBacktestsEnabled === true,
    allowDuplicateMarkets: input?.allowDuplicateMarkets === true,
    maxMembers: Math.max(1, Math.min(12, Number(input?.maxMembers || 6))),
    robust: {
      minProfitFactor: Number(input?.robust?.minProfitFactor ?? 1.15),
      maxDrawdownPercent: Number(input?.robust?.maxDrawdownPercent ?? 22),
      minTrades: Math.max(1, Number(input?.robust?.minTrades || 40)),
    },
    strategyTypes: parseStrategyTypes(input?.strategyTypes).length > 0
      ? parseStrategyTypes(input?.strategyTypes)
      : ['DD_BattleToads', 'stat_arb_zscore', 'zz_breakout'],
    monoMarkets: hasMonoMarkets
      ? parsedMonoMarkets
      : defaultMonoMarkets,
    synthMarkets: hasSynthMarkets
      ? parsedSynthMarkets
      : defaultSynthMarkets,
    ddLengths: parseNumberList((input as any)?.ddLengths).length > 0
      ? parseNumberList((input as any)?.ddLengths)
      : defaultDdLengths,
    ddTakeProfits: parseNumberList((input as any)?.ddTakeProfits).length > 0
      ? parseNumberList((input as any)?.ddTakeProfits)
      : defaultDdTakeProfits,
    ddSources: parseDdSources((input as any)?.ddSources).length > 0
      ? parseDdSources((input as any)?.ddSources)
      : defaultDdSources,
    statLengths: parseNumberList((input as any)?.statLengths).length > 0
      ? parseNumberList((input as any)?.statLengths)
      : defaultStatLengths,
    statEntry: parseNumberList((input as any)?.statEntry).length > 0
      ? parseNumberList((input as any)?.statEntry)
      : defaultStatEntry,
    statExit: parseNumberList((input as any)?.statExit).length > 0
      ? parseNumberList((input as any)?.statExit)
      : defaultStatExit,
    statStop: parseNumberList((input as any)?.statStop).length > 0
      ? parseNumberList((input as any)?.statStop)
      : defaultStatStop,
    systemName: safeSystemName,
    strategyPrefix: safePrefix,
  };
};

const buildStrategyName = (config: HistoricalSweepConfig, plan: SweepRunPlan): string => {
  const modeToken = plan.marketMode === 'mono' ? 'M' : 'S';
  const marketToken = plan.market.replace(/\//g, '_');
  if (plan.strategyType === 'stat_arb_zscore') {
    return `${config.strategyPrefix}_SZ_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}_ZE${formatMetricToken(plan.zscoreEntry)}_ZX${formatMetricToken(plan.zscoreExit)}_ZS${formatMetricToken(plan.zscoreStop)}`;
  }
  const typeToken = plan.strategyType === 'zz_breakout' ? 'ZZ' : 'DD';
  return `${config.strategyPrefix}_${typeToken}_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}_TP${formatMetricToken(plan.takeProfitPercent)}_SRC${plan.detectionSource}`;
};

const buildRunPlans = (config: HistoricalSweepConfig): SweepRunPlan[] => {
  const plans: SweepRunPlan[] = [];
  let runIndex = 0;
  const intervals = Array.isArray(config.intervals) && config.intervals.length > 0
    ? config.intervals
    : [config.interval || '4h'];

  const addPlan = (base: Omit<SweepRunPlan, 'index' | 'key' | 'strategyName'>) => {
    const index = ++runIndex;
    const planBase: SweepRunPlan = {
      ...base,
      index,
      key: '',
      strategyName: '',
    };
    const strategyName = buildStrategyName(config, planBase);
    plans.push({
      ...planBase,
      strategyName,
      key: strategyName,
    });
  };

  const addMarketRuns = (marketMode: 'mono' | 'synth', market: string) => {
    const { baseSymbol, quoteSymbol } = parseMarket(market);
    for (const interval of intervals) {
      for (const strategyType of config.strategyTypes) {
      if (strategyType === 'stat_arb_zscore') {
        for (const length of config.statLengths) {
          for (const zscoreEntry of config.statEntry) {
            for (const zscoreExit of config.statExit) {
              for (const zscoreStop of config.statStop) {
                addPlan({
                  strategyType,
                  marketMode,
                  market,
                  baseSymbol,
                  quoteSymbol,
                  interval,
                  length,
                  takeProfitPercent: 0,
                  detectionSource: 'close',
                  zscoreEntry,
                  zscoreExit,
                  zscoreStop,
                });
              }
            }
          }
        }
        continue;
      }

      for (const length of config.ddLengths) {
        for (const takeProfitPercent of config.ddTakeProfits) {
          for (const detectionSource of config.ddSources) {
            addPlan({
              strategyType,
              marketMode,
              market,
              baseSymbol,
              quoteSymbol,
              interval,
              length,
              takeProfitPercent,
              detectionSource,
              zscoreEntry: 2,
              zscoreExit: 0.5,
              zscoreStop: 3.5,
            });
          }
        }
      }
      }
    }
  };

  config.monoMarkets.forEach((market) => addMarketRuns('mono', market));
  config.synthMarkets.forEach((market) => addMarketRuns('synth', market));
  return plans;
};

const computeScore = (ret: number, pf: number, dd: number, wr: number, trades: number): number => {
  const tradeBonus = Math.min(12, Math.log10(Math.max(1, trades)) * 5);
  return Number((ret + pf * 10 + wr * 0.12 - dd * 1.2 + tradeBonus).toFixed(6));
};

const isRobust = (config: HistoricalSweepConfig, record: SweepRecordInternal): boolean => {
  return Number(record.profitFactor) >= config.robust.minProfitFactor
    && Number(record.maxDrawdownPercent) <= config.robust.maxDrawdownPercent
    && Number(record.tradesCount) >= config.robust.minTrades;
};

const readCheckpoint = (filePath: string): SweepCheckpoint | null => {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as SweepCheckpoint;
  } catch (error) {
    logger.warn(`[fullHistoricalSweep] invalid checkpoint ignored: ${(error as Error).message}`);
    return null;
  }
};

const writeCheckpoint = (filePath: string, checkpoint: SweepCheckpoint): void => {
  fs.writeFileSync(filePath, JSON.stringify(checkpoint, null, 2));
};

const updateJobRow = async (
  jobId: number,
  patch: {
    status?: JobStatus;
    processedRuns: number;
    totalRuns: number;
    successRuns: number;
    failedRuns: number;
    currentKey?: string;
    error?: string;
    details?: Record<string, unknown>;
    finished?: boolean;
  }
): Promise<void> => {
  const db = getResearchDb();
  const safeTotalRuns = Math.max(0, Number(patch.totalRuns || 0));
  const safeProcessedRuns = safeTotalRuns > 0
    ? Math.min(safeTotalRuns, Math.max(0, Number(patch.processedRuns || 0)))
    : Math.max(0, Number(patch.processedRuns || 0));
  const remaining = Math.max(0, safeTotalRuns - safeProcessedRuns);
  const progressPercent = safeTotalRuns > 0 ? Number(((safeProcessedRuns / safeTotalRuns) * 100).toFixed(2)) : 0;
  await db.run(
    `UPDATE research_backfill_jobs
     SET status = ?,
         requested_max_days = ?,
         analyzed_days = ?,
         missing_days = ?,
         processed_days = ?,
         created_runs = ?,
         skipped_days = ?,
         current_day_key = ?,
         progress_percent = ?,
         details_json = ?,
         error = ?,
         updated_at = CURRENT_TIMESTAMP,
         finished_at = CASE WHEN ? = 1 THEN CURRENT_TIMESTAMP ELSE finished_at END
     WHERE id = ?`,
    [
      patch.status || 'running',
      safeTotalRuns,
      safeTotalRuns,
      remaining,
      safeProcessedRuns,
      patch.successRuns,
      patch.failedRuns,
      String(patch.currentKey || ''),
      progressPercent,
      JSON.stringify({
        totalRuns: safeTotalRuns,
        processedRuns: safeProcessedRuns,
        successRuns: patch.successRuns,
        failedRuns: patch.failedRuns,
        ...(patch.details || {}),
      }),
      String(patch.error || ''),
      patch.finished ? 1 : 0,
      jobId,
    ]
  );
};

const createJobRow = async (mode: SweepMode, totalRuns: number, config: HistoricalSweepConfig): Promise<number> => {
  const db = getResearchDb();
  const result = await db.run(
    `INSERT INTO research_backfill_jobs (
      job_key, mode, status,
      requested_max_days, analyzed_days, missing_days,
      processed_days, created_runs, skipped_days,
      current_day_key, eta_seconds, progress_percent,
      details_json, error, started_at, updated_at
    ) VALUES (
      'full_historical_sweep', ?, 'running',
      ?, ?, ?,
      0, 0, 0,
      '', 0, 0,
      ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      mode,
      totalRuns,
      totalRuns,
      totalRuns,
      JSON.stringify({
        config,
        totalRuns,
        processedRuns: 0,
        successRuns: 0,
        failedRuns: 0,
      }),
    ]
  );
  return Number(result?.lastID || 0);
};

const getLatestJob = async (): Promise<Record<string, unknown>> => {
  const db = getResearchDb();
  const row = await db.get(
    `SELECT *
     FROM research_backfill_jobs
     WHERE job_key = 'full_historical_sweep'
     ORDER BY id DESC
     LIMIT 1`
  ) as Record<string, unknown> | undefined;

  if (!row) {
    return { exists: false };
  }

  let details: Record<string, unknown> = {};
  try {
    details = JSON.parse(String(row.details_json || '{}')) as Record<string, unknown>;
  } catch {
    details = {};
  }

  const totalRuns = Math.max(0, Number(details.totalRuns || row.requested_max_days || 0));
  const processedRunsRaw = Math.max(0, Number(details.processedRuns || row.processed_days || 0));
  const processedRuns = totalRuns > 0 ? Math.min(totalRuns, processedRunsRaw) : processedRunsRaw;
  const progressPercent = totalRuns > 0
    ? Number(((processedRuns / totalRuns) * 100).toFixed(2))
    : Math.max(0, Math.min(100, Number(row.progress_percent || 0)));

  details = {
    ...details,
    totalRuns,
    processedRuns,
  };

  return {
    exists: true,
    ...row,
    processed_days: processedRuns,
    progress_percent: progressPercent,
    details,
  };
};

const getJobStatusById = async (jobId: number): Promise<JobStatus | null> => {
  const db = getResearchDb();
  const row = await db.get(
    `SELECT status
     FROM research_backfill_jobs
     WHERE id = ?
     LIMIT 1`,
    [jobId]
  ) as { status?: string } | undefined;

  const status = String(row?.status || '').trim().toLowerCase();
  if (status === 'queued' || status === 'running' || status === 'done' || status === 'failed') {
    return status as JobStatus;
  }
  return null;
};

const buildStrategyDraft = (plan: SweepRunPlan): Partial<Strategy> => ({
  name: plan.strategyName,
  strategy_type: plan.strategyType,
  market_mode: plan.marketMode === 'mono' ? 'mono' : 'synthetic',
  is_active: false,
  display_on_chart: false,
  show_settings: false,
  show_chart: false,
  show_indicators: false,
  show_positions_on_chart: false,
  show_trades_on_chart: false,
  show_values_each_bar: false,
  auto_update: false,
  take_profit_percent: plan.takeProfitPercent,
  price_channel_length: plan.length,
  detection_source: plan.detectionSource,
  zscore_entry: plan.zscoreEntry,
  zscore_exit: plan.zscoreExit,
  zscore_stop: plan.zscoreStop,
  base_symbol: plan.baseSymbol,
  quote_symbol: plan.marketMode === 'mono' ? '' : plan.quoteSymbol,
  interval: plan.interval,
  base_coef: 1,
  quote_coef: plan.marketMode === 'mono' ? 0 : 1,
  long_enabled: true,
  short_enabled: true,
  lot_long_percent: 10,
  lot_short_percent: 10,
  max_deposit: 1000,
  margin_type: 'cross',
  leverage: 20,
  fixed_lot: false,
  reinvest_percent: 0,
});

const ensureStrategyForPlan = async (
  apiKeyName: string,
  strategyMap: Map<string, Strategy>,
  config: HistoricalSweepConfig,
  plan: SweepRunPlan
): Promise<{ strategy: Strategy; created: boolean }> => {
  const existing = strategyMap.get(plan.strategyName);
  const draft = buildStrategyDraft(plan);

  if (existing?.id) {
    if (config.updateExistingStrategies) {
      const updated = await updateStrategy(apiKeyName, Number(existing.id), draft, {
        allowBindingUpdate: true,
        source: 'full_historical_sweep',
      });
      strategyMap.set(plan.strategyName, updated);
      return { strategy: updated, created: false };
    }
    return { strategy: existing, created: false };
  }

  const created = await createStrategy(apiKeyName, draft);
  strategyMap.set(plan.strategyName, created);
  return { strategy: created, created: true };
};

const appendLogLine = (filePath: string, line: string): void => {
  fs.appendFileSync(filePath, `${line}\n`);
};

const buildTopByType = (rows: SweepRecordInternal[]): Record<string, SweepRecordInternal[]> => {
  const groups = new Map<string, SweepRecordInternal[]>();
  for (const row of rows) {
    const key = String(row.strategyType || 'unknown');
    const next = groups.get(key) || [];
    next.push(row);
    groups.set(key, next);
  }

  const out: Record<string, SweepRecordInternal[]> = {};
  for (const [key, value] of groups.entries()) {
    out[key] = [...value].sort((left, right) => Number(right.score || 0) - Number(left.score || 0)).slice(0, 12);
  }
  return out;
};

const buildSweepArtifact = async (
  config: HistoricalSweepConfig,
  evaluated: SweepRecordInternal[],
  failures: SweepFailure[],
  startedAtMs: number
): Promise<SweepData & Record<string, unknown>> => {
  const sorted = [...evaluated].sort((left, right) => Number(right.score || 0) - Number(left.score || 0));
  const topAll = sorted.slice(0, 24);
  const topByMode = {
    mono: sorted.filter((row) => row.marketMode === 'mono').slice(0, 12),
    synth: sorted.filter((row) => row.marketMode === 'synth').slice(0, 12),
  };
  const selectedMembers = sorted.filter((row) => Boolean(row.robust)).slice(0, config.maxMembers);

  let portfolioResults: Array<Record<string, unknown>> = [];
  if (selectedMembers.length > 1) {
    try {
      const result = await runBacktest({
        apiKeyName: config.apiKeyName,
        mode: 'portfolio',
        strategyIds: selectedMembers.map((item) => Number(item.strategyId)),
        bars: config.backtestBars,
        dateFrom: config.dateFrom,
        dateTo: config.dateTo || undefined,
        warmupBars: config.warmupBars,
        skipMissingSymbols: config.skipMissingSymbols,
        initialBalance: config.initialBalance,
        commissionPercent: config.commissionPercent,
        slippagePercent: config.slippagePercent,
        fundingRatePercent: config.fundingRatePercent,
      });
      portfolioResults = [{
        type: 'full_range',
        summary: result.summary,
      }];
    } catch (error) {
      portfolioResults = [{
        type: 'full_range',
        error: (error as Error).message,
      }];
    }
  }

  return {
    timestamp: new Date().toISOString(),
    apiKeyName: config.apiKeyName,
    config,
    universe: {
      sweepFile: path.join(repoRoot, 'backend', 'logs', 'backtests', 'third_strategy_sweep_seed_btdd_d1.json'),
      synthMarkets: config.synthMarkets,
      monoMarkets: config.monoMarkets,
    },
    counts: {
      potentialRuns: config.maxRuns,
      scheduledRuns: config.maxRuns,
      coveragePercent: config.maxRuns > 0 ? Number(((evaluated.length / config.maxRuns) * 100).toFixed(2)) : 0,
      evaluated: evaluated.length,
      failures: failures.length,
      robust: evaluated.filter((item) => Boolean(item.robust)).length,
      resumedFromCheckpoint: false,
      skippedFromCheckpoint: 0,
      resumedFromLog: false,
      importedFromLog: 0,
      logImportMissingStrategyIds: 0,
      durationSec: Math.max(0, Math.round((Date.now() - startedAtMs) / 1000)),
    },
    failures,
    topAll,
    topByType: buildTopByType(evaluated),
    topByMode,
    selectedMembers,
    tradingSystem: {
      id: 0,
      name: config.systemName,
      members: selectedMembers.map((item, index) => ({
        strategy_id: Number(item.strategyId),
        weight: Number((index === 0 ? 1.25 : index === 1 ? 1.1 : 1).toFixed(4)),
        member_role: index < 3 ? 'core' : 'satellite',
        is_enabled: true,
        notes: 'historical sweep candidate',
      })),
    },
    portfolioResults,
    evaluated,
  };
};

const processJob = async (jobId: number, config: HistoricalSweepConfig, mode: SweepMode): Promise<void> => {
  if (activeJobs.has(jobId)) {
    return;
  }
  activeJobs.add(jobId);

  ensureResultsDir();
  await initDB();
  await initResearchDb();
  await ensureExchangeClientInitialized(config.apiKeyName);
  const startedAtMs = Date.now();
  const logFilePath = path.join(repoRoot, 'logs', `historical_${toIsoSafe(new Date(startedAtMs))}.log`);
  const allStrategies = await getStrategies(config.apiKeyName, { includeLotPreview: false, limit: 20000 });
  const strategyMap = new Map(allStrategies.map((item) => [String(item.name || ''), item]));
  const plans = buildRunPlans(config);
  const totalRuns = Math.min(plans.length, config.maxRuns);
  const planKeys = new Set(plans.slice(0, totalRuns).map((item) => item.key));
  const checkpoint = config.resumeEnabled ? readCheckpoint(config.checkpointFile) : null;
  const checkpointEvaluatedRaw = Array.isArray(checkpoint?.evaluated) ? checkpoint!.evaluated : [];
  const checkpointFailuresRaw = Array.isArray(checkpoint?.failures) ? checkpoint!.failures : [];

  const evaluatedByKey = new Map<string, SweepRecordInternal>();
  for (const item of checkpointEvaluatedRaw) {
    const key = String(item?.strategyName || '');
    if (!key || !planKeys.has(key) || evaluatedByKey.has(key)) {
      continue;
    }
    evaluatedByKey.set(key, item);
  }

  const failuresByKey = new Map<string, SweepFailure>();
  for (const item of checkpointFailuresRaw) {
    const key = String(item?.key || item?.strategyName || '');
    if (!key || !planKeys.has(key) || failuresByKey.has(key) || evaluatedByKey.has(key)) {
      continue;
    }
    failuresByKey.set(key, item);
  }

  const evaluated: SweepRecordInternal[] = Array.from(evaluatedByKey.values());
  const failures: SweepFailure[] = Array.from(failuresByKey.values());
  if (evaluated.length + failures.length > totalRuns) {
    const cappedEvaluated = evaluated.slice(0, totalRuns);
    const remainingSlots = Math.max(0, totalRuns - cappedEvaluated.length);
    const cappedFailures = remainingSlots > 0 ? failures.slice(0, remainingSlots) : [];
    evaluated.length = 0;
    failures.length = 0;
    evaluated.push(...cappedEvaluated);
    failures.push(...cappedFailures);
  }
  const completedKeys = new Set<string>([
    ...evaluated.map((item) => String(item.strategyName || item.strategyId)),
    ...failures.map((item) => String(item.key || item.strategyName)),
  ]);
  const resumedFromCheckpoint = Boolean(checkpoint);
  const skippedFromCheckpoint = completedKeys.size;

  if (resumedFromCheckpoint) {
    const droppedCheckpointRows = (checkpointEvaluatedRaw.length + checkpointFailuresRaw.length) - (evaluated.length + failures.length);
    if (droppedCheckpointRows > 0) {
      logger.warn(`[fullHistoricalSweep] dropped ${droppedCheckpointRows} checkpoint rows outside current run plan`);
    }
  }

  try {
    appendLogLine(logFilePath, `--- HISTORICAL SWEEP START ${new Date(startedAtMs).toISOString()} ---`);
    await updateJobRow(jobId, {
      status: 'running',
      processedRuns: completedKeys.size,
      totalRuns,
      successRuns: evaluated.length,
      failedRuns: failures.length,
      currentKey: completedKeys.size > 0 ? 'resume' : '',
      details: {
        config,
        logFilePath,
        resumedFromCheckpoint,
        skippedFromCheckpoint,
      },
    });

    for (const plan of plans) {
      if (plan.index > totalRuns) {
        break;
      }

      const currentStatus = await getJobStatusById(jobId);
      if (currentStatus !== 'running') {
        appendLogLine(logFilePath, `[RUN LOOP STOP] job=${jobId} status=${String(currentStatus || 'missing')}`);
        break;
      }

      if (completedKeys.has(plan.key)) {
        continue;
      }

      const processedBefore = evaluated.length + failures.length;
      try {
        const ensured = await ensureStrategyForPlan(config.apiKeyName, strategyMap, config, plan);
        const strategyId = Number(ensured.strategy.id || 0);
        const result = await runBacktest({
          apiKeyName: config.apiKeyName,
          mode: 'single',
          strategyId,
          bars: config.backtestBars,
          dateFrom: config.dateFrom,
          dateTo: config.dateTo || undefined,
          warmupBars: config.warmupBars,
          skipMissingSymbols: config.skipMissingSymbols,
          initialBalance: config.initialBalance,
          commissionPercent: config.commissionPercent,
          slippagePercent: config.slippagePercent,
          fundingRatePercent: config.fundingRatePercent,
        });

        const summary = result.summary;
        const record: SweepRecordInternal = {
          strategyId,
          strategyIdResolved: strategyId > 0,
          strategyName: plan.strategyName,
          created: ensured.created,
          strategyType: plan.strategyType,
          marketMode: plan.marketMode,
          market: plan.market,
          interval: plan.interval,
          length: plan.length,
          takeProfitPercent: plan.takeProfitPercent,
          detectionSource: plan.detectionSource,
          zscoreEntry: plan.zscoreEntry,
          zscoreExit: plan.zscoreExit,
          zscoreStop: plan.zscoreStop,
          finalEquity: Number(summary.finalEquity || 0),
          totalReturnPercent: Number(summary.totalReturnPercent || 0),
          maxDrawdownPercent: Number(summary.maxDrawdownPercent || 0),
          winRatePercent: Number(summary.winRatePercent || 0),
          profitFactor: Number(summary.profitFactor || 0),
          tradesCount: Number(summary.tradesCount || 0),
          score: 0,
          robust: false,
          runIndex: plan.index,
          restoredFromLog: false,
        };
        record.score = computeScore(record.totalReturnPercent, record.profitFactor, record.maxDrawdownPercent, record.winRatePercent, record.tradesCount);
        record.robust = isRobust(config, record);
        evaluated.push(record);
        completedKeys.add(plan.key);
        appendLogLine(logFilePath, `[RUN ${plan.index}/${totalRuns}] OK ${plan.strategyName} RET=${record.totalReturnPercent} PF=${record.profitFactor} DD=${record.maxDrawdownPercent} WR=${record.winRatePercent} TRADES=${record.tradesCount} SCORE=${record.score}`);
      } catch (error) {
        const failure: SweepFailure = {
          runIndex: plan.index,
          key: plan.key,
          strategyName: plan.strategyName,
          strategyType: plan.strategyType,
          marketMode: plan.marketMode,
          market: plan.market,
          error: (error as Error).message,
        };
        failures.push(failure);
        completedKeys.add(plan.key);
        appendLogLine(logFilePath, `[RUN ${plan.index}/${totalRuns}] FAIL ${plan.strategyName} ${failure.error}`);
      }

      const processedRuns = evaluated.length + failures.length;
      await updateJobRow(jobId, {
        status: 'running',
        processedRuns,
        totalRuns,
        successRuns: evaluated.length,
        failedRuns: failures.length,
        currentKey: plan.strategyName,
        details: {
          config,
          logFilePath,
          resumedFromCheckpoint,
          skippedFromCheckpoint,
        },
      });

      if (config.resumeEnabled && (processedRuns === totalRuns || processedRuns % config.checkpointEvery === 0 || processedRuns !== processedBefore)) {
        writeCheckpoint(config.checkpointFile, {
          config,
          startedAt: new Date(startedAtMs).toISOString(),
          evaluated,
          failures,
        });
      }
    }

    const sweepData = await buildSweepArtifact(config, evaluated, failures, startedAtMs);
    sweepData.counts.resumedFromCheckpoint = resumedFromCheckpoint;
    sweepData.counts.skippedFromCheckpoint = skippedFromCheckpoint;

    const artifactTimestamp = toIsoSafe();
    const sweepFilePath = path.join(resultsDir, `${config.apiKeyName.toLowerCase()}_historical_sweep_${artifactTimestamp}.json`);
    fs.writeFileSync(sweepFilePath, JSON.stringify(sweepData, null, 2));

    const catalogData: CatalogData = buildClientCatalogFromSweepData(sweepData, {
      sweepFilePath,
      durationSec: Number(sweepData.counts.durationSec || 0),
      maxMembers: config.maxMembers,
    });
    const catalogFilePath = path.join(resultsDir, `${config.apiKeyName.toLowerCase()}_client_catalog_${artifactTimestamp}.json`);
    fs.writeFileSync(catalogFilePath, JSON.stringify(catalogData, null, 2));

    const importResult = await importHistoricalArtifactsToResearch({
      catalogFilePath,
      sweepFilePath,
      sweepName: `${config.strategyPrefix}_${artifactTimestamp}`,
      description: 'Full historical sweep import',
    });

    appendLogLine(logFilePath, `Saved: ${sweepFilePath}`);
    appendLogLine(logFilePath, `Saved: ${catalogFilePath}`);
    appendLogLine(logFilePath, `Research import: sweepRunId=${importResult.sweepRunId} imported=${importResult.imported} skipped=${importResult.skipped}`);
    appendLogLine(logFilePath, '--- HISTORICAL SWEEP SUMMARY ---');
    appendLogLine(logFilePath, JSON.stringify({ counts: sweepData.counts, source: importResult.source }, null, 2));

    await updateJobRow(jobId, {
      status: 'done',
      processedRuns: evaluated.length + failures.length,
      totalRuns,
      successRuns: evaluated.length,
      failedRuns: failures.length,
      currentKey: '',
      finished: true,
      details: {
        config,
        logFilePath,
        resumedFromCheckpoint,
        skippedFromCheckpoint,
        sweepFilePath,
        catalogFilePath,
        researchImport: importResult,
      },
    });
  } catch (error) {
    const message = (error as Error).message;
    appendLogLine(logFilePath, `FATAL: ${message}`);
    await updateJobRow(jobId, {
      status: 'failed',
      processedRuns: evaluated.length + failures.length,
      totalRuns,
      successRuns: evaluated.length,
      failedRuns: failures.length,
      currentKey: '',
      error: message,
      finished: true,
      details: {
        config,
        logFilePath,
        resumedFromCheckpoint,
        skippedFromCheckpoint,
      },
    });
    logger.error(`[fullHistoricalSweep] job=${jobId} failed: ${message}`);
  } finally {
    activeJobs.delete(jobId);
  }
};

export const startFullHistoricalSweepJob = async (input?: Partial<HistoricalSweepConfig> & { mode?: unknown }): Promise<Record<string, unknown>> => {
  await initResearchDb();
  const db = getResearchDb();
  const running = await db.get(
    `SELECT id
     FROM research_backfill_jobs
     WHERE job_key = 'full_historical_sweep' AND status = 'running'
     ORDER BY id DESC
     LIMIT 1`
  ) as { id?: number } | undefined;

  if (running?.id) {
    return {
      started: false,
      reason: 'Full historical sweep already running',
      jobId: Number(running.id),
    };
  }

  const mode = normalizeMode(input?.mode);
  const config = buildDefaultConfig(input);
  const plans = buildRunPlans(config);
  config.maxRuns = Math.min(config.maxRuns, plans.length);
  const jobId = await createJobRow(mode, config.maxRuns, config);
  if (!Number.isFinite(jobId) || jobId <= 0) {
    throw new Error('Failed to create full historical sweep job');
  }

  void processJob(jobId, config, mode);
  return {
    started: true,
    jobId,
    mode,
    totalRuns: config.maxRuns,
    config,
  };
};

export const getFullHistoricalSweepStatus = async (): Promise<Record<string, unknown>> => {
  await initResearchDb();
  return getLatestJob();
};

export const abortRunningFullHistoricalSweepJob = async (reason: string = 'aborted by operator') => {
  await initResearchDb();
  const db = getResearchDb();
  const running = await db.get(
    `SELECT id
     FROM research_backfill_jobs
     WHERE job_key = 'full_historical_sweep' AND status = 'running'
     ORDER BY id DESC
     LIMIT 1`
  ) as { id?: number } | undefined;

  if (!running?.id) {
    return {
      aborted: false,
      reason: 'No running full historical sweep job',
    };
  }

  await db.run(
    `UPDATE research_backfill_jobs
     SET status = 'failed',
         error = ?,
         finished_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [String(reason || 'aborted by operator'), Number(running.id)]
  );

  return {
    aborted: true,
    jobId: Number(running.id),
    reason: String(reason || 'aborted by operator'),
  };
};
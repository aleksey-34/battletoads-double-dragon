import fs from 'fs';
import path from 'path';
import { fork, ChildProcess } from 'child_process';
import { runBacktest } from '../backtest/engine';
import { ensureExchangeClientInitialized, getExchangeForApiKey, getAllSymbols, getMarketData } from '../bot/exchange';
import { createStrategy, getStrategies, updateStrategy } from '../bot/strategy';
import { Strategy } from '../config/settings';
import { initResearchDb, getResearchDb } from './db';
import { initDB } from '../utils/database';
import logger from '../utils/logger';
import { buildClientCatalogFromSweepData, CatalogData, SweepData, SweepRecord, refreshOfferStoreSnapshotsFromSweep } from '../saas/service';
import { importHistoricalArtifactsToResearch } from './importService';

type SweepMode = 'light' | 'heavy';
type JobStatus = 'queued' | 'running' | 'done' | 'failed';

type HistoricalSweepConfig = {
  apiKeyName: string;
  fanApiKeyNames: string[];
  concurrency: number;
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
  strategyTypes: Array<'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout' | 'ZZ_Fast' | 'ZZ_Instance' | 'hideep' | 'CT_Fractal'>;
  monoMarkets: string[];
  synthMarkets: string[];
  ddLengths: number[];
  ddTakeProfits: number[];
  ddSources: Array<'close' | 'wick'>;
  zzPivotLengths: number[];
  statLengths: number[];
  statEntry: number[];
  statExit: number[];
  statStop: number[];
  hidDeepMac1: number[];
  hidDeepRsiPeriod: number[];
  hidDeepTakeProfits: number[];
  systemName: string;
  strategyPrefix: string;
  sweepLotPercent: number;
  sweepReinvestPercent: number;
  sweepMaxDeposit: number;
  longOnly: boolean;
  spotMode: boolean;
};

type SweepRunPlan = {
  key: string;
  index: number;
  strategyType: 'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout' | 'ZZ_Fast' | 'ZZ_Instance' | 'hideep' | 'CT_Fractal';
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

const parseStrategyTypes = (raw: unknown): Array<'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout' | 'ZZ_Fast' | 'ZZ_Instance' | 'hideep' | 'CT_Fractal'> => {
  const values = parseStringList(raw);
  const allowed = new Set([
    'DD_BATTLETOADS', 'STAT_ARB_ZSCORE', 'ZZ_BREAKOUT', 'ZZ_FAST', 'ZZ_INSTANCE', 'HIDEEP', 'CT_FRACTAL',
    'ZZ_HAMSTER_ZZ6', 'ZZ_HAMSTER_ZZ2',
  ]);
  const parsed = values
    .filter((value) => allowed.has(value))
    .map((value) => {
      if (value === 'DD_BATTLETOADS') {
        return 'DD_BattleToads';
      }
      if (value === 'ZZ_BREAKOUT') {
        return 'zz_breakout';
      }
      if (value === 'ZZ_FAST' || value === 'ZZ_HAMSTER_ZZ6') {
        return 'ZZ_Fast';
      }
      if (value === 'ZZ_INSTANCE' || value === 'ZZ_HAMSTER_ZZ2') {
        return 'ZZ_Instance';
      }
      if (value === 'HIDEEP') {
        return 'hideep';
      }
      if (value === 'CT_FRACTAL') {
        return 'CT_Fractal';
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
  // Fan keys must preserve original case — DB stores some api_keys lowercase
  // (e.g. "mustafa", "ivan_weex_1", "tenant-69182-weex-ghfmsb").
  const parseFanKeyList = (raw: unknown): string[] => {
    const arr = Array.isArray(raw) ? raw : String(raw || '').split(/[\s,;|]+/);
    return Array.from(new Set(arr.map((item) => String(item || '').trim()).filter(Boolean)));
  };
  const fanApiKeyNamesRaw = parseFanKeyList((input as any)?.fanApiKeyNames);
  const fanApiKeyNames = fanApiKeyNamesRaw.length > 0
    ? Array.from(new Set([apiKeyName, ...fanApiKeyNamesRaw]))
        .map((name) => String(name).trim())
        .filter(Boolean)
    : [apiKeyName];
  const concurrency = Math.max(1, Math.min(32, Number((input as any)?.concurrency || 1)));
  const dateFrom = String(input?.dateFrom || '2025-01-01T00:00:00Z').trim() || '2025-01-01T00:00:00Z';
  const dateTo = input?.dateTo ? String(input.dateTo).trim() : null;
  // Prefer multi-interval `intervals` array when present — single `interval`
  // string is the legacy/fallback. Previous `input.interval || input.intervals`
  // short-circuited to the single value whenever both fields were sent,
  // silently shrinking ["1h","2h","4h","1d"] to just ["1h"].
  const rawIntervals = (input as any)?.intervals;
  const hasIntervalsArray = Array.isArray(rawIntervals)
    ? rawIntervals.length > 0
    : (typeof rawIntervals === 'string' && rawIntervals.trim().length > 0);
  const intervals = parseIntervals(hasIntervalsArray ? rawIntervals : (input?.interval || '4h'));
  const interval = intervals[0] || '4h';
  const safePrefix = String(input?.strategyPrefix || 'HISTSWEEP').trim() || 'HISTSWEEP';
  const safeSystemName = String(input?.systemName || `${safePrefix} ${apiKeyName} Candidate`).trim() || `${safePrefix} ${apiKeyName} Candidate`;
  const checkpointFile = input?.checkpointFile
    ? String(input.checkpointFile)
    : path.join(resultsDir, `${apiKeyName.toLowerCase()}_historical_sweep_checkpoint.json`);
  const hasMonoMarkets = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'monoMarkets') && (input as any).monoMarkets !== undefined);
  const hasSynthMarkets = Boolean(input && Object.prototype.hasOwnProperty.call(input, 'synthMarkets') && (input as any).synthMarkets !== undefined);
  const parsedMonoMarkets = parseStringList((input as any)?.monoMarkets);
  const parsedSynthMarkets = parseStringList((input as any)?.synthMarkets);

  return {
    apiKeyName,
    fanApiKeyNames,
    concurrency,
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
    longOnly: (input as any)?.longOnly === true,
    spotMode: (input as any)?.spotMode === true,
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
    zzPivotLengths: parseNumberList((input as any)?.zzPivotLengths).length > 0
      ? parseNumberList((input as any)?.zzPivotLengths)
      : parseNumberList((input as any)?.zzHamsterLengths).length > 0
        ? parseNumberList((input as any)?.zzHamsterLengths)
        : [2, 3, 5, 6],
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
    hidDeepMac1: parseNumberList((input as any)?.hidDeepMac1).length > 0
      ? parseNumberList((input as any)?.hidDeepMac1)
      : [8, 10, 14],
    hidDeepRsiPeriod: parseNumberList((input as any)?.hidDeepRsiPeriod).length > 0
      ? parseNumberList((input as any)?.hidDeepRsiPeriod)
      : [2, 3],
    hidDeepTakeProfits: parseNumberList((input as any)?.hidDeepTakeProfits).length > 0
      ? parseNumberList((input as any)?.hidDeepTakeProfits)
      : [3, 5, 7.5],
    systemName: safeSystemName,
    strategyPrefix: safePrefix,
    sweepLotPercent: Math.max(0, Math.min(100, Number((input as any)?.sweepLotPercent ?? 10))),
    sweepReinvestPercent: Math.max(0, Math.min(100, Number((input as any)?.sweepReinvestPercent ?? 0))),
    sweepMaxDeposit: Math.max(0, Number((input as any)?.sweepMaxDeposit ?? 1000)),
  };
};

const buildStrategyName = (config: HistoricalSweepConfig, plan: SweepRunPlan): string => {
  const modeToken = plan.marketMode === 'mono' ? 'M' : 'S';
  const marketToken = plan.market.replace(/\//g, '_');
  if (plan.strategyType === 'stat_arb_zscore') {
    return `${config.strategyPrefix}_SZ_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}_ZE${formatMetricToken(plan.zscoreEntry)}_ZX${formatMetricToken(plan.zscoreExit)}_ZS${formatMetricToken(plan.zscoreStop)}`;
  }
  if (plan.strategyType === 'CT_Fractal') {
    return `${config.strategyPrefix}_CTF_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}_ZE${formatMetricToken(plan.zscoreEntry)}_ZX${formatMetricToken(plan.zscoreExit)}_ZS${formatMetricToken(plan.zscoreStop)}`;
  }
  if (plan.strategyType === 'hideep') {
    return `${config.strategyPrefix}_HD_${modeToken}_${marketToken}_${plan.interval}_M${plan.length}_R${formatMetricToken(plan.zscoreEntry)}_TP${formatMetricToken(plan.takeProfitPercent)}`;
  }
  if (plan.strategyType === 'ZZ_Fast') {
    return `${config.strategyPrefix}_ZZF_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}`;
  }
  if (plan.strategyType === 'ZZ_Instance') {
    return `${config.strategyPrefix}_ZZI_${modeToken}_${marketToken}_${plan.interval}_L${plan.length}`;
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

      if (strategyType === 'CT_Fractal') {
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

      if (strategyType === 'hideep') {
        for (const mac1 of config.hidDeepMac1) {
          for (const rsiPeriod of config.hidDeepRsiPeriod) {
            for (const takeProfitPercent of config.hidDeepTakeProfits) {
              addPlan({
                strategyType,
                marketMode,
                market,
                baseSymbol,
                quoteSymbol,
                interval,
                length: mac1,           // price_channel_length = mac1
                takeProfitPercent,
                detectionSource: 'close',
                zscoreEntry: rsiPeriod, // zscore_entry = rsiPeriod (up1)
                zscoreExit: 90,         // exit when fastRSI > 90
                zscoreStop: 100,        // sma1 period
              });
            }
          }
        }
        continue;
      }

      if (strategyType === 'ZZ_Fast' || strategyType === 'ZZ_Instance') {
        const lengths = config.zzPivotLengths.length > 0 ? config.zzPivotLengths : [2, 3, 5, 6];
        for (const length of lengths) {
          addPlan({
            strategyType,
            marketMode,
            market,
            baseSymbol,
            quoteSymbol,
            interval,
            length,
            takeProfitPercent: 0,
            detectionSource: 'wick',
            zscoreEntry: 2,
            zscoreExit: 0.5,
            zscoreStop: 3.5,
          });
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

  // ── Per-(strategy_type, market) quota via maxVariantsPerMarketType ──
  // Without this cap, stat_arb (270 variants/market) drowns DD (72) and ZZ (72)
  // when maxRuns truncates the queue. Cap each (strategy_type, market) bucket
  // to maxVariantsPerMarketType variants — distributed evenly via stride
  // sampling so we keep parameter diversity instead of head-only.
  const maxPerBucket = Math.max(1, Number(config.maxVariantsPerMarketType || 8));
  const buckets = new Map<string, SweepRunPlan[]>();
  for (const p of plans) {
    const k = `${p.strategyType}::${p.marketMode}:${p.market}::${p.interval}`;
    const arr = buckets.get(k);
    if (arr) arr.push(p); else buckets.set(k, [p]);
  }
  const stratified: SweepRunPlan[] = [];
  for (const [, arr] of buckets) {
    if (arr.length <= maxPerBucket) {
      stratified.push(...arr);
      continue;
    }
    // Stride-sample to keep diversity across the parameter grid
    const stride = arr.length / maxPerBucket;
    for (let i = 0; i < maxPerBucket; i++) {
      const idx = Math.min(arr.length - 1, Math.floor(i * stride));
      stratified.push(arr[idx]);
    }
  }

  // ── Round-robin interleave across (strategy_type, marketMode, market, interval) ──
  // Guarantees that any prefix of the plan list (e.g. when maxRuns truncates)
  // contains balanced coverage of ALL strategy types, market modes, intervals
  // and pairs. Previous version round-robin'd by market only, so when stat_arb
  // dominated bucket sizes, DD_BattleToads could be missed entirely.
  const queues = new Map<string, SweepRunPlan[]>();
  for (const p of stratified) {
    const k = `${p.strategyType}::${p.marketMode}:${p.market}::${p.interval}`;
    const arr = queues.get(k);
    if (arr) arr.push(p); else queues.set(k, [p]);
  }
  const queueList = Array.from(queues.values());
  const interleaved: SweepRunPlan[] = [];
  let active = queueList.length;
  while (active > 0) {
    active = 0;
    for (const q of queueList) {
      const item = q.shift();
      if (item) { interleaved.push(item); active++; }
    }
  }
  // Re-assign sequential indices so worker progress logs reflect interleaved order.
  return interleaved.map((p, i) => ({ ...p, index: i + 1 }));
};

const computeScore = (ret: number, pf: number, dd: number, wr: number, trades: number): number => {
  const tradeBonus = Math.min(12, Math.log10(Math.max(1, trades)) * 5);
  const ddOverPenalty = dd > 30 ? (dd - 30) * 2.5 : 0;
  const ddUnderBonus = dd <= 30 ? (30 - dd) * 0.35 : 0;
  return Number((ret + pf * 10 + wr * 0.12 - dd * 1.2 - ddOverPenalty + ddUnderBonus + tradeBonus).toFixed(6));
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

const buildStrategyDraft = (plan: SweepRunPlan, config: HistoricalSweepConfig): Partial<Strategy> => ({
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
  short_enabled: !config.longOnly,
  lot_long_percent: config.sweepLotPercent,
  lot_short_percent: config.sweepLotPercent,
  max_deposit: config.sweepMaxDeposit,
  margin_type: 'cross',
  leverage: config.spotMode ? 1 : 20,
  fixed_lot: false,
  reinvest_percent: config.sweepReinvestPercent,
  market_type: config.spotMode ? 'spot' : 'futures',
});

const ensureStrategyForPlan = async (
  apiKeyName: string,
  strategyMap: Map<string, Strategy>,
  config: HistoricalSweepConfig,
  plan: SweepRunPlan
): Promise<{ strategy: Strategy; created: boolean }> => {
  const existing = strategyMap.get(plan.strategyName);
  const draft = buildStrategyDraft(plan, config);

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

  // Sweep creates many parallel strategy variants per pair (different intervals,
  // lengths, TPs, z-score grids). The legacy uniqueness check is meant to
  // prevent UI users from accidentally bind two strategies to the same pair —
  // it has no meaning for backtest-only sweep, where every plan is distinct
  // (ZE/ZX/TP/length differ). Allow active-pair conflict so sweep can build
  // the full grid even when daily/manual strategies already exist on the pair.
  const created = await createStrategy(apiKeyName, draft, { allowActivePairConflict: true });
  strategyMap.set(plan.strategyName, created);
  return { strategy: created, created: true };
};

const appendLogLine = (filePath: string, line: string): void => {
  fs.appendFileSync(filePath, `${line}\n`);
};

/**
 * Scan all historical_*.log files in the logs dir and collect keys of
 * runs already executed in past sweeps (OK / FAIL / SKIP-NO-EXCHANGE).
 * Used as a fallback when checkpoint file is missing — we don't want to
 * re-run the same plan keys after a crash/abort. Returns a Set of plan keys
 * (strategy names, since [RUN N/T] OK/FAIL/SKIP lines log the strategyName).
 */
const collectCompletedKeysFromLogs = (logsDir: string, currentLogPath: string): {
  okByName: Map<string, { ret: number; pf: number; dd: number; wr: number; trades: number; score: number }>;
  failedNames: Set<string>;
  skippedNames: Set<string>;
} => {
  const okByName = new Map<string, { ret: number; pf: number; dd: number; wr: number; trades: number; score: number }>();
  const failedNames = new Set<string>();
  const skippedNames = new Set<string>();
  if (!fs.existsSync(logsDir)) return { okByName, failedNames, skippedNames };
  let files: string[] = [];
  try {
    files = fs.readdirSync(logsDir).filter((f) => /^historical_.*\.log$/.test(f));
  } catch { return { okByName, failedNames, skippedNames }; }
  const okRe = /^\[RUN \d+\/\d+\] OK (\S+) RET=(\S+) PF=(\S+) DD=(\S+) WR=(\S+) TRADES=(\S+) SCORE=(\S+)/;
  const failRe = /^\[RUN \d+\/\d+\] FAIL (\S+) /;
  const skipRe = /^\[RUN \d+\/\d+\] SKIP-NO-EXCHANGE (\S+) /;
  for (const f of files) {
    const full = path.join(logsDir, f);
    if (full === currentLogPath) continue;
    let txt = '';
    try { txt = fs.readFileSync(full, 'utf-8'); } catch { continue; }
    const lines = txt.split(/\r?\n/);
    for (const ln of lines) {
      const ok = okRe.exec(ln);
      if (ok) {
        const name = ok[1];
        // Keep first OK encountered (most recent runs are at end; we overwrite intentionally)
        okByName.set(name, {
          ret: Number(ok[2]) || 0,
          pf: Number(ok[3]) || 0,
          dd: Number(ok[4]) || 0,
          wr: Number(ok[5]) || 0,
          trades: Number(ok[6]) || 0,
          score: Number(ok[7]) || 0,
        });
        failedNames.delete(name);
        skippedNames.delete(name);
        continue;
      }
      const fail = failRe.exec(ln);
      if (fail) {
        const name = fail[1];
        if (!okByName.has(name)) failedNames.add(name);
        continue;
      }
      const sk = skipRe.exec(ln);
      if (sk) {
        const name = sk[1];
        if (!okByName.has(name)) skippedNames.add(name);
      }
    }
  }
  return { okByName, failedNames, skippedNames };
};

/** Wrap a promise with a timeout that rejects after ms milliseconds. */
const withTimeout = <T>(p: Promise<T>, ms: number, label: string): Promise<T> => {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
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

export const processJob = async (jobId: number, config: HistoricalSweepConfig, mode: SweepMode): Promise<void> => {
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

  // Log-based resume: when checkpoint is missing/sparse, scan past
  // historical_*.log files and pre-populate completedKeys so we don't redo
  // work. We also restore OK summaries (so the final artifact ranks them).
  let logRestoredOk = 0;
  let logRestoredSkipped = 0;
  if (config.resumeEnabled) {
    const { okByName, failedNames, skippedNames } = collectCompletedKeysFromLogs(
      path.join(repoRoot, 'logs'),
      logFilePath,
    );
    const planByName = new Map<string, SweepRunPlan>();
    for (const p of plans.slice(0, totalRuns)) planByName.set(p.strategyName, p);

    for (const [name, m] of okByName.entries()) {
      const plan = planByName.get(name);
      if (!plan || evaluatedByKey.has(name)) continue;
      const restored: SweepRecordInternal = {
        strategyId: 0,
        strategyIdResolved: false,
        strategyName: name,
        created: false,
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
        finalEquity: 0,
        totalReturnPercent: m.ret,
        maxDrawdownPercent: m.dd,
        winRatePercent: m.wr,
        profitFactor: m.pf,
        tradesCount: m.trades,
        score: m.score,
        robust: false,
        runIndex: plan.index,
        restoredFromLog: true,
      };
      restored.robust = isRobust(config, restored);
      evaluatedByKey.set(name, restored);
      logRestoredOk++;
    }
    for (const name of failedNames) {
      const plan = planByName.get(name);
      if (!plan || failuresByKey.has(name) || evaluatedByKey.has(name)) continue;
      failuresByKey.set(name, {
        runIndex: plan.index,
        key: plan.key,
        strategyName: name,
        strategyType: plan.strategyType,
        marketMode: plan.marketMode,
        market: plan.market,
        error: 'restored-from-log: previous FAIL',
      });
      logRestoredSkipped++;
    }
    for (const name of skippedNames) {
      const plan = planByName.get(name);
      if (!plan || failuresByKey.has(name) || evaluatedByKey.has(name)) continue;
      failuresByKey.set(name, {
        runIndex: plan.index,
        key: plan.key,
        strategyName: name,
        strategyType: plan.strategyType,
        marketMode: plan.marketMode,
        market: plan.market,
        error: 'restored-from-log: previous SKIP-NO-EXCHANGE',
      });
      logRestoredSkipped++;
    }
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
  const resumedFromCheckpoint = Boolean(checkpoint) || (logRestoredOk + logRestoredSkipped) > 0;
  const skippedFromCheckpoint = completedKeys.size;

  if (resumedFromCheckpoint) {
    const droppedCheckpointRows = (checkpointEvaluatedRaw.length + checkpointFailuresRaw.length) - (evaluated.length + failures.length);
    if (droppedCheckpointRows > 0) {
      logger.warn(`[fullHistoricalSweep] dropped ${droppedCheckpointRows} checkpoint rows outside current run plan`);
    }
    if (logRestoredOk + logRestoredSkipped > 0) {
      logger.info(`[fullHistoricalSweep] resumed from log: OK=${logRestoredOk} SKIP=${logRestoredSkipped}`);
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

    // ── Concurrency: process plans in parallel batches ──────────────────────
    // Sweep is mostly CPU-bound (backtest engine) plus initial candle fetch per (pair,interval).
    // With single api-key and process-local candleAutoCache, the first ~N unique fetches dominate;
    // afterwards everything runs from RAM cache. We rotate apiKeyName across config.fanApiKeyNames
    // so candle fetches are distributed across multiple exchanges/keys (each with its own
    // rate-limit), and we run config.concurrency plans in parallel via async-pool.
    const fanKeys = (Array.isArray(config.fanApiKeyNames) && config.fanApiKeyNames.length > 0)
      ? config.fanApiKeyNames
      : [config.apiKeyName];
    const concurrency = Math.max(1, Math.min(32, Number(config.concurrency || 1)));

    // ── Symbol-aware routing ────────────────────────────────────────────────
    // For each fan-key we discover its exchange and the full symbol set listed
    // there. Then for every plan we filter fanKeys down to those whose exchange
    // actually has the required symbol(s) — mono needs baseSymbol, synth needs
    // both base & quote. This lets a single sweep mix Bybit/MEXC/BingX/WEEX
    // keys safely: each plan goes only to compatible exchanges, so no more
    // 100% failure storms when a Bybit-listed pair is routed to a MEXC key.
    const keyToSymbols = new Map<string, Set<string>>();
    const keyToExchange = new Map<string, string>();
    for (const k of fanKeys) {
      try {
        await ensureExchangeClientInitialized(k);
        const ex = getExchangeForApiKey(k) || '';
        keyToExchange.set(k, ex);
        try {
          const syms = await getAllSymbols(k);
          const set = new Set<string>(
            (Array.isArray(syms) ? syms : []).map((s: any) =>
              String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
            ).filter(Boolean)
          );
          keyToSymbols.set(k, set);
          appendLogLine(logFilePath, `[FAN-KEY] ${k} exchange=${ex} symbols=${set.size}`);
        } catch (e) {
          appendLogLine(logFilePath, `[FAN-KEY] ${k} symbol-fetch FAILED: ${(e as Error).message} — key will be skipped for routing`);
          keyToSymbols.set(k, new Set());
        }
      } catch (e) {
        appendLogLine(logFilePath, `[FAN-KEY] ${k} init FAILED: ${(e as Error).message}`);
        keyToSymbols.set(k, new Set());
      }
    }

    const normSym = (s: string): string =>
      String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

    const pickKeysForPlan = (plan: SweepRunPlan): string[] => {
      const required: string[] = [];
      if (plan.marketMode === 'mono') {
        required.push(normSym(plan.baseSymbol || plan.market));
      } else {
        required.push(normSym(plan.baseSymbol));
        if (plan.quoteSymbol) required.push(normSym(plan.quoteSymbol));
      }
      const matches = fanKeys.filter((k) => {
        const set = keyToSymbols.get(k);
        if (!set || set.size === 0) return false;
        return required.every((r) => r && set.has(r));
      });
      return matches;
    };

    // Per-fan-key round-robin counters (so even with symbol filtering we still
    // distribute load evenly within the eligible subset for each plan).
    const keyRoundRobinIdx: Record<string, number> = {};
    for (const k of fanKeys) keyRoundRobinIdx[k] = 0;
    let globalRR = 0;

    let stopRequested = false;
    let nextPlanIdx = 0;
    let inflight = 0;
    let lastStatusCheckAt = 0;
    // [OPT-B] Job-row write throttle state
    let lastJobRowWriteAt = 0;
    let lastJobRowWriteAtCount = 0;

    // ── [OPT-D] Prewarm pass: probe each unique (fanKey, symbol, interval) ──
    // route used by any plan. 30s timeout. Routes that fail prewarm are added
    // to badRoutes and excluded from pickKeysForPlan, so we don't burn 90s of
    // sweep time per plan on dead/slow data routes (the dominant cause of the
    // ~26% failure rate observed on jobs #71/72).
    const badRoutes = new Set<string>();
    const probeRoutes = new Map<string, { fanKey: string; symbol: string; interval: string }>();
    for (const plan of plans) {
      const required: string[] = [];
      if (plan.marketMode === 'mono') {
        required.push(plan.baseSymbol || plan.market);
      } else {
        required.push(plan.baseSymbol);
        if (plan.quoteSymbol) required.push(plan.quoteSymbol);
      }
      const eligible = pickKeysForPlan(plan);
      for (const fanKey of eligible) {
        for (const sym of required) {
          if (!sym) continue;
          const k = `${fanKey}::${sym}::${plan.interval}`;
          if (!probeRoutes.has(k)) probeRoutes.set(k, { fanKey, symbol: sym, interval: plan.interval });
        }
      }
    }
    appendLogLine(logFilePath, `[PREWARM] probing ${probeRoutes.size} unique (key,symbol,interval) routes with concurrency=${Math.min(16, concurrency)}`);
    {
      const queue = Array.from(probeRoutes.values());
      let idx = 0; let ok = 0; let bad = 0;
      const PREWARM_CONCURRENCY = Math.min(16, concurrency);
      const worker = async (): Promise<void> => {
        while (idx < queue.length) {
          const r = queue[idx++];
          if (!r) break;
          try {
            // Probe with 50 candles is enough to verify exchange liveness; full
            // history will be cached lazily by backtest engine on first real call.
            await withTimeout(getMarketData(r.fanKey, r.symbol, r.interval, 50), 30_000, `prewarm ${r.fanKey}/${r.symbol}/${r.interval}`);
            ok++;
          } catch (probeErr) {
            badRoutes.add(`${r.fanKey}::${r.symbol}::${r.interval}`);
            bad++;
          }
        }
      };
      const workers: Promise<void>[] = [];
      for (let i = 0; i < PREWARM_CONCURRENCY; i++) workers.push(worker());
      await Promise.all(workers);
      appendLogLine(logFilePath, `[PREWARM] done: ok=${ok} bad=${bad} (badRoutes=${badRoutes.size})`);
    }

    const pickKeysForPlanFiltered = (plan: SweepRunPlan): string[] => {
      const required: string[] = [];
      if (plan.marketMode === 'mono') {
        required.push(plan.baseSymbol || plan.market);
      } else {
        required.push(plan.baseSymbol);
        if (plan.quoteSymbol) required.push(plan.quoteSymbol);
      }
      return pickKeysForPlan(plan).filter((k) =>
        !required.some((r) => r && badRoutes.has(`${k}::${r}::${plan.interval}`))
      );
    };

    const runOnePlan = async (plan: SweepRunPlan, fanKey: string): Promise<void> => {
      const processedBefore = evaluated.length + failures.length;
      try {
        const ensured = await ensureStrategyForPlan(config.apiKeyName, strategyMap, config, plan);
        const strategyId = Number(ensured.strategy.id || 0);
        // Per-plan hard timeout — without this a single hung candle fetch can
        // freeze the whole sweep (concurrency slot never frees up).
        // [OPT-A] Per-plan timeout reduced 180s→90s. WEEX/BingX hung fetches
        //         used to waste a full concurrency slot for 3 minutes. Combined
        //         with prewarm (D) most slow routes are skipped before they start.
        // [OPT-E] Inner retry for transient SQLITE_BUSY: backtest engine writes
        //         to multiple tables under high concurrency, occasionally losing
        //         the SQLite lock race. Without retry, ~90% of plans failed in
        //         the 4-interval sweep due to "SQLITE_BUSY: database is locked".
        const callBacktest = () => withTimeout(
          runBacktest({
            // Strategy lives on the master key; fanKey only routes candle fetch.
            apiKeyName: config.apiKeyName,
            dataApiKeyName: fanKey,
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
          }),
          90_000,
          `${plan.strategyName} via ${fanKey}`,
        );
        let result: Awaited<ReturnType<typeof callBacktest>>;
        let attempt = 0;
        const MAX_ATTEMPTS = 12;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          attempt++;
          try {
            result = await callBacktest();
            break;
          } catch (err) {
            const msg = (err as Error).message || '';
            const transient = /SQLITE_BUSY|database is locked|SQLITE_LOCKED/i.test(msg);
            if (!transient || attempt >= MAX_ATTEMPTS) {
              throw err;
            }
            // Exponential backoff capped at 8s with jitter.
            // 12 attempts: 0.5s, 1s, 2s, 4s, 8s, 8s, 8s, 8s, 8s, 8s, 8s, 8s ~ 75s total.
            // Combined with PRAGMA busy_timeout=120s this should virtually
            // eliminate transient failures even under 24-worker load.
            const baseMs = Math.min(8000, 500 * 2 ** (attempt - 1));
            const jitterMs = Math.floor(Math.random() * 500);
            await new Promise((r) => setTimeout(r, baseMs + jitterMs));
          }
        }

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
        const sumAny = summary as any;
        record.actualDataStartMs = Number.isFinite(Number(sumAny.actualDataStartMs)) ? Number(sumAny.actualDataStartMs) : null;
        record.actualDataEndMs = Number.isFinite(Number(sumAny.actualDataEndMs)) ? Number(sumAny.actualDataEndMs) : null;
        evaluated.push(record);
        completedKeys.add(plan.key);
        const startIso = record.actualDataStartMs ? new Date(record.actualDataStartMs).toISOString().slice(0, 10) : '-';
        appendLogLine(logFilePath, `[RUN ${plan.index}/${totalRuns}] OK ${plan.strategyName} RET=${record.totalReturnPercent} PF=${record.profitFactor} DD=${record.maxDrawdownPercent} WR=${record.winRatePercent} TRADES=${record.tradesCount} SCORE=${record.score} START=${startIso}`);
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
      // [OPT-B] Throttled updateJobRow: full job-row write only every 5s OR
      //         every 25 plans OR on terminal completion. Per-plan writes were
      //         causing SQLITE_BUSY contention against the live btdd-api DB.
      const nowMs = Date.now();
      const sinceLastWrite = nowMs - lastJobRowWriteAt;
      const dueByTime = sinceLastWrite >= 5_000;
      const dueByCount = (processedRuns - lastJobRowWriteAtCount) >= 25;
      const dueByTerminal = processedRuns === totalRuns;
      if (dueByTime || dueByCount || dueByTerminal) {
        lastJobRowWriteAt = nowMs;
        lastJobRowWriteAtCount = processedRuns;
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
      }

      if (config.resumeEnabled && (processedRuns === totalRuns || processedRuns % config.checkpointEvery === 0 || processedRuns !== processedBefore)) {
        writeCheckpoint(config.checkpointFile, {
          config,
          startedAt: new Date(startedAtMs).toISOString(),
          evaluated,
          failures,
        });
      }
    };

    await new Promise<void>((resolveAll) => {
      const tryLaunch = () => {
        if (stopRequested) {
          if (inflight === 0) resolveAll();
          return;
        }
        while (inflight < concurrency && nextPlanIdx < plans.length) {
          const plan = plans[nextPlanIdx++];
          if (plan.index > totalRuns || completedKeys.has(plan.key)) {
            continue;
          }
          // Throttled status-check (every 5s) to detect external abort without per-plan DB query
          const now = Date.now();
          if (now - lastStatusCheckAt > 5000) {
            lastStatusCheckAt = now;
            getJobStatusById(jobId).then((status) => {
              if (status !== 'running') {
                stopRequested = true;
                appendLogLine(logFilePath, `[RUN LOOP STOP] job=${jobId} status=${String(status || 'missing')}`);
              }
            }).catch(() => {});
          }
          inflight++;
          // Symbol-aware routing: pick only fan-keys whose exchange has the
          // required symbol(s); round-robin within that subset. If no fan-key
          // can serve this plan we record a clean failure and keep going.
          const eligible = pickKeysForPlanFiltered(plan);
          if (eligible.length === 0) {
            const failure: SweepFailure = {
              runIndex: plan.index,
              key: plan.key,
              strategyName: plan.strategyName,
              strategyType: plan.strategyType,
              marketMode: plan.marketMode,
              market: plan.market,
              error: `no fan-key supports ${plan.marketMode === 'mono' ? plan.baseSymbol || plan.market : `${plan.baseSymbol}/${plan.quoteSymbol}`} (checked ${fanKeys.length} keys)`,
            };
            failures.push(failure);
            completedKeys.add(plan.key);
            appendLogLine(logFilePath, `[RUN ${plan.index}/${totalRuns}] SKIP-NO-EXCHANGE ${plan.strategyName} ${failure.error}`);
            const processedRuns = evaluated.length + failures.length;
            updateJobRow(jobId, {
              status: 'running',
              processedRuns,
              totalRuns,
              successRuns: evaluated.length,
              failedRuns: failures.length,
              currentKey: plan.strategyName,
              details: { config, logFilePath, resumedFromCheckpoint, skippedFromCheckpoint },
            }).catch(() => {});
            inflight--;
            continue;
          }
          const fanKey = eligible[(globalRR++) % eligible.length];
          runOnePlan(plan, fanKey).finally(() => {
            inflight--;
            tryLaunch();
          });
        }
        if (inflight === 0 && nextPlanIdx >= plans.length) {
          resolveAll();
        }
      };
      tryLaunch();
    });

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

    let snapshotRefreshResult: Awaited<ReturnType<typeof refreshOfferStoreSnapshotsFromSweep>> | null = null;
    try {
      snapshotRefreshResult = await refreshOfferStoreSnapshotsFromSweep({
        force: true,
        reason: 'research_full_historical_sweep',
        sweepTimestamp: String(sweepData.timestamp || ''),
      });
      appendLogLine(
        logFilePath,
        `Snapshot refresh: ok=${snapshotRefreshResult.ok} skipped=${snapshotRefreshResult.skipped} systems=${snapshotRefreshResult.systemsUpdated} offers=${snapshotRefreshResult.offersUpdated}`,
      );
    } catch (snapshotError) {
      appendLogLine(logFilePath, `Snapshot refresh failed: ${(snapshotError as Error).message}`);
      logger.error(`[fullHistoricalSweep] snapshot refresh failed: ${(snapshotError as Error).message}`);
    }

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
        snapshotRefresh: snapshotRefreshResult,
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

  spawnSweepWorker(jobId);
  return {
    started: true,
    jobId,
    mode,
    totalRuns: config.maxRuns,
    config,
    workerSpawned: true,
  };
};

// Track child workers spawned by this API process. We use detached:true so
// the worker survives an API restart (log-resume + DB-poll abort keep things
// safe). Map is best-effort: an orphaned worker from a previous API process
// will simply not appear here, and abort still works via the existing DB
// status flip that the worker polls every 5s.
const sweepWorkers = new Map<number, ChildProcess>();

const spawnSweepWorker = (jobId: number): void => {
  const workerScript = path.join(__dirname, 'sweepWorkerEntry.js');
  if (!fs.existsSync(workerScript)) {
    logger.error(`[fullHistoricalSweep] worker script missing: ${workerScript}; falling back to in-process run`);
    void (async () => {
      try {
        await initResearchDb();
        const db = getResearchDb();
        const row = (await db.get(
          `SELECT mode, details_json FROM research_backfill_jobs WHERE id=? LIMIT 1`,
          [jobId]
        )) as { mode?: string; details_json?: string } | undefined;
        if (!row) return;
        const parsed = JSON.parse(String(row.details_json || '{}')) as { config?: HistoricalSweepConfig };
        if (!parsed.config) return;
        await processJob(jobId, parsed.config, (row.mode === 'light' ? 'light' : 'heavy'));
      } catch (e) {
        logger.error(`[fullHistoricalSweep] inline fallback failed: ${(e as Error).message}`);
      }
    })();
    return;
  }

  const child = fork(workerScript, [String(jobId)], {
    detached: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    env: { ...process.env },
  });
  sweepWorkers.set(jobId, child);
  logger.info(`[fullHistoricalSweep] spawned worker pid=${child.pid} for job=${jobId}`);
  child.on('exit', (code, signal) => {
    sweepWorkers.delete(jobId);
    logger.info(`[fullHistoricalSweep] worker pid=${child.pid} job=${jobId} exited code=${code} signal=${signal}`);
  });
  child.on('error', (err) => {
    logger.error(`[fullHistoricalSweep] worker job=${jobId} error: ${err.message}`);
  });
  // Allow the API process to exit independently of the worker.
  child.unref();
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

  // Best-effort: send SIGTERM to in-tree worker (the DB flip is the
  // canonical signal; the 5s poll inside processJob will pick it up).
  const child = sweepWorkers.get(Number(running.id));
  if (child && !child.killed) {
    try { child.kill('SIGTERM'); } catch { /* noop */ }
  }

  return {
    aborted: true,
    jobId: Number(running.id),
    reason: String(reason || 'aborted by operator'),
    workerSignaled: Boolean(child && !child.killed),
  };
};

export type { HistoricalSweepConfig };
export { buildRunPlans as buildHistoricalSweepRunPlans };
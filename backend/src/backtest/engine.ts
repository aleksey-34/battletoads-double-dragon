import { MarketMode, Strategy, StrategyType } from '../config/settings';
import { getStrategies } from '../bot/strategy';
import { getMarketData } from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { db } from '../utils/database';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';

export type BacktestMode = 'single' | 'portfolio';

type DetectionSource = 'wick' | 'close';
type Signal = 'long' | 'short' | 'none';
type PositionState = 'flat' | 'long' | 'short';

type ParsedCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

export type BacktestPoint = {
  time: number;
  equity: number;
};

export type BacktestTrade = {
  strategyId: number;
  strategyName: string;
  side: 'long' | 'short';
  entryTime: number;
  exitTime: number;
  entryPrice: number;
  exitPrice: number;
  notional: number;
  grossPnl: number;
  netPnl: number;
  pnlPercent: number;
  fees: number;
  funding: number;
  reason: string;
};

export type BacktestSummary = {
  mode: BacktestMode;
  apiKeyName: string;
  strategyIds: number[];
  strategyNames: string[];
  interval: string;
  barsRequested: number;
  barsProcessed: number;
  dateFromMs: number | null;
  dateToMs: number | null;
  warmupBars: number;
  skippedStrategies: number;
  processedStrategies: number;
  initialBalance: number;
  finalEquity: number;
  totalReturnPercent: number;
  maxDrawdownPercent: number;
  maxDrawdownAbsolute: number;
  tradesCount: number;
  winRatePercent: number;
  profitFactor: number;
  grossProfit: number;
  grossLoss: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
};

export type BacktestRunRequest = {
  apiKeyName: string;
  mode?: BacktestMode;
  strategyId?: number;
  strategyIds?: number[];
  bars?: number;
  dateFrom?: string | number;
  dateTo?: string | number;
  warmupBars?: number;
  skipMissingSymbols?: boolean;
  initialBalance?: number;
  commissionPercent?: number;
  slippagePercent?: number;
  fundingRatePercent?: number;
};

export type BacktestRunResult = {
  request: BacktestRunRequest;
  summary: BacktestSummary;
  equityCurve: BacktestPoint[];
  trades: BacktestTrade[];
  runId?: number;
};

type NormalizedBacktestRequest = {
  apiKeyName: string;
  mode: BacktestMode;
  strategyId: number;
  strategyIds: number[];
  bars: number;
  dateFromMs: number | null;
  dateToMs: number | null;
  warmupBars: number;
  skipMissingSymbols: boolean;
  initialBalance: number;
  commissionPercent: number;
  slippagePercent: number;
  fundingRatePercent: number;
};

export type BacktestRunListItem = {
  id: number;
  created_at: string;
  api_key_name: string;
  mode: BacktestMode;
  strategy_ids: number[];
  strategy_names: string[];
  interval: string;
  bars: number;
  initial_balance: number;
  final_equity: number;
  total_return_percent: number;
  max_drawdown_percent: number;
  trades_count: number;
  win_rate_percent: number;
  profit_factor: number;
};

const asNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const clamp = (value: number, min: number, max: number): number => {
  return Math.min(max, Math.max(min, value));
};

const parseTimestampMs = (value: any): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value > 9999999999 ? Math.floor(value) : Math.floor(value * 1000);
  }

  const text = String(value).trim();
  if (!text) {
    return null;
  }

  const numeric = Number(text);
  if (Number.isFinite(numeric)) {
    return numeric > 9999999999 ? Math.floor(numeric) : Math.floor(numeric * 1000);
  }

  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.floor(parsed);
};

const eventLoopYield = async (): Promise<void> => {
  await new Promise<void>((resolve) => setImmediate(resolve));
};

const maybeYieldByCounter = async (counter: number, chunk: number = 250): Promise<void> => {
  if (counter > 0 && counter % chunk === 0) {
    await eventLoopYield();
  }
};

const normalizeDateCachePart = (value: any): string => {
  return String(value || '').trim().toUpperCase();
};

const intervalToMs = (interval: string): number => {
  const value = String(interval || '').trim();

  if (value.endsWith('m')) {
    const minutes = Number.parseInt(value.replace('m', ''), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  }

  if (value.endsWith('h')) {
    const hours = Number.parseInt(value.replace('h', ''), 10);
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  if (value === '1d') {
    return 24 * 60 * 60 * 1000;
  }

  if (value === '1w') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (value === '1M') {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
};

const parseCandle = (item: any): ParsedCandle | null => {
  if (Array.isArray(item) && item.length >= 5) {
    const timeMs = Number(item[0]);
    const open = Number(item[1]);
    const high = Number(item[2]);
    const low = Number(item[3]);
    const close = Number(item[4]);

    if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
      return null;
    }

    return {
      timeMs,
      open,
      high,
      low,
      close,
    };
  }

  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return {
    timeMs,
    open,
    high,
    low,
    close,
  };
};

type BacktestSignalPayload = {
  signal: Signal;
  current: number;
  donchianCenter: number;
  zScore: number | null;
};

const computeDonchianSignalAtIndex = (
  candles: ParsedCandle[],
  index: number,
  length: number,
  source: DetectionSource,
  longEnabled: boolean,
  shortEnabled: boolean
): BacktestSignalPayload => {
  if (index < length || index >= candles.length) {
    throw new Error(`Invalid index for signal calculation: ${index}`);
  }

  const current = candles[index];
  const window = candles.slice(index - length, index);

  if (window.length < length) {
    throw new Error(`Not enough candles for Donchian signal: need ${length}, got ${window.length}`);
  }

  const highs = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.high);
  const lows = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.low);

  const donchianHigh = Math.max(...highs);
  const donchianLow = Math.min(...lows);
  const donchianCenter = (donchianHigh + donchianLow) / 2;

  const longBreakout = source === 'close' ? current.close >= donchianHigh : current.high >= donchianHigh;
  const shortBreakout = source === 'close' ? current.close <= donchianLow : current.low <= donchianLow;

  if (longEnabled && longBreakout) {
    return {
      signal: 'long',
      current: current.close,
      donchianCenter,
      zScore: null,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      current: current.close,
      donchianCenter,
      zScore: null,
    };
  }

  return {
    signal: 'none',
    current: current.close,
    donchianCenter,
    zScore: null,
  };
};

const computeStatArbSignalAtIndex = (
  candles: ParsedCandle[],
  index: number,
  length: number,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): BacktestSignalPayload => {
  if (index < length || index >= candles.length) {
    throw new Error(`Invalid index for signal calculation: ${index}`);
  }

  const current = candles[index];
  const window = candles.slice(index - length, index);

  if (window.length < length) {
    throw new Error(`Not enough candles for z-score signal: need ${length}, got ${window.length}`);
  }

  const series = window.map((bar) => bar.close);
  const avg = mean(series);
  const sigma = stddev(series);

  if (!Number.isFinite(sigma) || sigma <= 1e-12) {
    return {
      signal: 'none',
      current: current.close,
      donchianCenter: avg,
      zScore: 0,
    };
  }

  const zScore = (current.close - avg) / sigma;

  if (shortEnabled && zScore >= zscoreEntry) {
    return {
      signal: 'short',
      current: current.close,
      donchianCenter: avg,
      zScore,
    };
  }

  if (longEnabled && zScore <= -zscoreEntry) {
    return {
      signal: 'long',
      current: current.close,
      donchianCenter: avg,
      zScore,
    };
  }

  return {
    signal: 'none',
    current: current.close,
    donchianCenter: avg,
    zScore,
  };
};

const computeSignalAtIndex = (
  strategyType: StrategyType,
  candles: ParsedCandle[],
  index: number,
  length: number,
  source: DetectionSource,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): BacktestSignalPayload => {
  if (strategyType === 'stat_arb_zscore') {
    return computeStatArbSignalAtIndex(candles, index, length, zscoreEntry, longEnabled, shortEnabled);
  }

  return computeDonchianSignalAtIndex(candles, index, length, source, longEnabled, shortEnabled);
};

type OpenTradeState = {
  side: 'long' | 'short';
  entryTime: number;
  entryPrice: number;
  notional: number;
  entryFee: number;
  funding: number;
};

type RuntimeStrategy = {
  strategy: Strategy;
  candles: ParsedCandle[];
  currentPrice: number;
  state: PositionState;
  entryPrice: number | null;
  tpAnchorPrice: number | null;
  notional: number;
  openTrade: OpenTradeState | null;
  startIndex: number;
  endIndex: number;
};

type BacktestContext = {
  cashEquity: number;
  commissionRate: number;
  slippageRate: number;
  fundingRate: number;
  trades: BacktestTrade[];
};

const executionPrice = (price: number, side: 'long' | 'short', phase: 'entry' | 'exit', slippageRate: number): number => {
  if (!Number.isFinite(price) || price <= 0) {
    return price;
  }

  if (phase === 'entry') {
    return side === 'long'
      ? price * (1 + slippageRate)
      : price * (1 - slippageRate);
  }

  return side === 'long'
    ? price * (1 - slippageRate)
    : price * (1 + slippageRate);
};

const unrealizedPnl = (runtime: RuntimeStrategy): number => {
  if (runtime.state === 'flat' || !runtime.entryPrice || !Number.isFinite(runtime.notional) || runtime.notional <= 0) {
    return 0;
  }

  if (!Number.isFinite(runtime.currentPrice) || runtime.currentPrice <= 0) {
    return 0;
  }

  if (runtime.state === 'long') {
    return runtime.notional * ((runtime.currentPrice / runtime.entryPrice) - 1);
  }

  return runtime.notional * ((runtime.entryPrice / runtime.currentPrice) - 1);
};

const portfolioEquity = (cashEquity: number, runtimes: RuntimeStrategy[]): number => {
  const unrealized = runtimes.reduce((sum, runtime) => sum + unrealizedPnl(runtime), 0);
  return cashEquity + unrealized;
};

const applyFunding = (ctx: BacktestContext, runtime: RuntimeStrategy): void => {
  if (!runtime.openTrade || runtime.state === 'flat' || runtime.notional <= 0) {
    return;
  }

  if (!Number.isFinite(ctx.fundingRate) || ctx.fundingRate === 0) {
    return;
  }

  const fundingCash = runtime.state === 'long'
    ? -runtime.notional * ctx.fundingRate
    : runtime.notional * ctx.fundingRate;

  ctx.cashEquity += fundingCash;
  runtime.openTrade.funding += fundingCash;
};

const closePosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  strategyId: number,
  strategyName: string,
  exitTime: number,
  marketPrice: number,
  reason: string
): void => {
  if (!runtime.openTrade || !runtime.entryPrice || runtime.notional <= 0 || runtime.state === 'flat') {
    runtime.state = 'flat';
    runtime.entryPrice = null;
    runtime.tpAnchorPrice = null;
    runtime.notional = 0;
    runtime.openTrade = null;
    return;
  }

  const side = runtime.openTrade.side;
  const exitPrice = executionPrice(marketPrice, side, 'exit', ctx.slippageRate);
  const entryPrice = runtime.openTrade.entryPrice;
  const notional = runtime.openTrade.notional;

  let grossPnl = 0;
  if (side === 'long') {
    grossPnl = notional * ((exitPrice / entryPrice) - 1);
  } else {
    grossPnl = notional * ((entryPrice / exitPrice) - 1);
  }

  const exitFee = notional * ctx.commissionRate;
  ctx.cashEquity += grossPnl - exitFee;

  const netPnl = grossPnl - runtime.openTrade.entryFee - exitFee + runtime.openTrade.funding;
  const pnlPercent = entryPrice > 0
    ? (side === 'long'
      ? ((exitPrice / entryPrice) - 1) * 100
      : ((entryPrice / exitPrice) - 1) * 100)
    : 0;

  ctx.trades.push({
    strategyId,
    strategyName,
    side,
    entryTime: runtime.openTrade.entryTime,
    exitTime,
    entryPrice,
    exitPrice,
    notional,
    grossPnl,
    netPnl,
    pnlPercent,
    fees: runtime.openTrade.entryFee + exitFee,
    funding: runtime.openTrade.funding,
    reason,
  });

  runtime.state = 'flat';
  runtime.entryPrice = null;
  runtime.tpAnchorPrice = null;
  runtime.notional = 0;
  runtime.openTrade = null;
};

const openPosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  signal: 'long' | 'short',
  eventTime: number,
  marketPrice: number,
  portfolioEquityNow: number
): boolean => {
  const strategy = runtime.strategy;

  const lotPercent = signal === 'long'
    ? asNumber(strategy.lot_long_percent, 0)
    : asNumber(strategy.lot_short_percent, 0);

  const lotFraction = Math.max(0, lotPercent) / 100;
  if (lotFraction <= 0) {
    return false;
  }

  const reinvestFactor = strategy.fixed_lot
    ? 1
    : 1 + Math.max(0, asNumber(strategy.reinvest_percent, 0)) / 100;

  const maxDeposit = asNumber(strategy.max_deposit, 0);
  const cappedBalance = maxDeposit > 0
    ? Math.min(portfolioEquityNow, maxDeposit)
    : portfolioEquityNow;

  const baseCapital = strategy.fixed_lot
    ? (maxDeposit > 0 ? maxDeposit : portfolioEquityNow)
    : cappedBalance;

  // Notional = capital × lot_fraction. Leverage is an exchange margin setting only,
  // NOT a position-size multiplier (consistent with live trading).
  const notional = baseCapital * lotFraction * reinvestFactor;
  if (!Number.isFinite(notional) || notional <= 0) {
    return false;
  }

  const entryPrice = executionPrice(marketPrice, signal, 'entry', ctx.slippageRate);
  const entryFee = notional * ctx.commissionRate;

  ctx.cashEquity -= entryFee;

  runtime.state = signal;
  runtime.entryPrice = entryPrice;
  runtime.tpAnchorPrice = marketPrice;
  runtime.notional = notional;
  runtime.openTrade = {
    side: signal,
    entryTime: eventTime,
    entryPrice,
    notional,
    entryFee,
    funding: 0,
  };

  return true;
};

type StrategyEvent = {
  strategyIndex: number;
  candleIndex: number;
  timeMs: number;
};

type RuntimeLoadResult = {
  runtimes: RuntimeStrategy[];
  skipped: Array<{ strategyId: number; strategyName: string; reason: string }>;
};

const normalizeStrategyType = (value: any): StrategyType => {
  const normalized = String(value || '').trim();
  if (normalized === 'stat_arb_zscore' || normalized === 'zz_breakout') {
    return normalized;
  }
  return 'DD_BattleToads';
};

const normalizeMarketMode = (value: any): MarketMode => {
  return String(value || '').trim() === 'mono' ? 'mono' : 'synthetic';
};

const normalizeZscoreEntry = (value: any): number => {
  return Math.max(0.1, asNumber(value, 2.0));
};

const normalizeZscoreExit = (value: any, entry: number): number => {
  const raw = Math.max(0, asNumber(value, 0.5));
  return Math.min(raw, Math.max(0, entry - 0.05));
};

const normalizeZscoreStop = (value: any, entry: number): number => {
  return Math.max(entry + 0.05, asNumber(value, 3.5));
};

const mean = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
};

const stddev = (values: number[]): number => {
  if (values.length === 0) {
    return 0;
  }

  const avg = mean(values);
  const variance = values.reduce((sum, value) => {
    const delta = value - avg;
    return sum + delta * delta;
  }, 0) / values.length;

  return Math.sqrt(Math.max(0, variance));
};

const syntheticCandleCache = new Map<string, ParsedCandle[]>();

const buildEvents = (runtimes: RuntimeStrategy[]): StrategyEvent[] => {
  const events: StrategyEvent[] = [];

  runtimes.forEach((runtime, strategyIndex) => {
    const startIndex = Math.max(0, runtime.startIndex);
    const endIndex = Math.min(runtime.candles.length - 1, runtime.endIndex);

    for (let index = startIndex; index <= endIndex; index += 1) {
      events.push({
        strategyIndex,
        candleIndex: index,
        timeMs: runtime.candles[index].timeMs,
      });
    }
  });

  events.sort((left, right) => {
    if (left.timeMs === right.timeMs) {
      return left.strategyIndex - right.strategyIndex;
    }
    return left.timeMs - right.timeMs;
  });

  return events;
};

const loadRuntimeStrategies = async (
  request: NormalizedBacktestRequest,
  strategies: Strategy[]
): Promise<RuntimeLoadResult> => {
  const runtimes: RuntimeStrategy[] = [];
  const skipped: Array<{ strategyId: number; strategyName: string; reason: string }> = [];
  let strategyCounter = 0;

  for (const strategy of strategies) {
    strategyCounter += 1;
    await maybeYieldByCounter(strategyCounter, 3);

    const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
    const interval = String(strategy.interval || '1h');
    const intervalMs = intervalToMs(interval);
    const warmupBars = Math.max(0, Math.floor(request.warmupBars));

    const rangeBars = request.dateFromMs !== null && request.dateToMs !== null
      ? Math.max(1, Math.ceil((request.dateToMs - request.dateFromMs) / Math.max(intervalMs, 1)) + 1)
      : request.bars;

    const candlesLimit = Math.max(length + warmupBars + 40, rangeBars + warmupBars + 20, request.bars);
    const fetchStartMs = request.dateFromMs !== null
      ? Math.max(0, request.dateFromMs - (warmupBars + length) * intervalMs)
      : null;
    const fetchEndMs = request.dateToMs;

    const cacheKey = [
      request.apiKeyName,
      normalizeMarketMode(strategy.market_mode),
      normalizeDateCachePart(strategy.base_symbol),
      normalizeDateCachePart(strategy.quote_symbol),
      asNumber(strategy.base_coef, 1),
      asNumber(strategy.quote_coef, 1),
      interval,
      candlesLimit,
      fetchStartMs ?? '',
      fetchEndMs ?? '',
    ].join('|');

    let candles = syntheticCandleCache.get(cacheKey);
    const marketMode = normalizeMarketMode(strategy.market_mode);

    if (!candles) {
      const raw = marketMode === 'mono'
        ? await getMarketData(
          request.apiKeyName,
          strategy.base_symbol,
          interval,
          candlesLimit,
          {
            startMs: fetchStartMs === null ? undefined : fetchStartMs,
            endMs: fetchEndMs === null ? undefined : fetchEndMs,
          }
        )
        : await calculateSyntheticOHLC(
          request.apiKeyName,
          strategy.base_symbol,
          strategy.quote_symbol,
          asNumber(strategy.base_coef, 1),
          asNumber(strategy.quote_coef, 1),
          interval,
          candlesLimit,
          {
            startMs: fetchStartMs === null ? undefined : fetchStartMs,
            endMs: fetchEndMs === null ? undefined : fetchEndMs,
          }
        );

      candles = (Array.isArray(raw) ? raw : [])
        .map((item) => parseCandle(item))
        .filter((item): item is ParsedCandle => !!item)
        .sort((a, b) => a.timeMs - b.timeMs);

      syntheticCandleCache.set(cacheKey, candles);
    }

    if (!candles || candles.length <= length) {
      const reason = `Not enough candles: got ${candles ? candles.length : 0}, need > ${length}`;
      if (request.skipMissingSymbols) {
        skipped.push({ strategyId: Number(strategy.id), strategyName: strategy.name, reason });
        continue;
      }
      throw new Error(
        `Not enough candles for strategy ${strategy.name} (${marketMode === 'mono' ? strategy.base_symbol : `${strategy.base_symbol}/${strategy.quote_symbol}`}): ${reason}`
      );
    }

    let firstInRangeIndex = 0;
    if (request.dateFromMs !== null) {
      const dateFromMs = request.dateFromMs;
      firstInRangeIndex = candles.findIndex((item) => item.timeMs >= dateFromMs);
      if (firstInRangeIndex < 0) {
        const reason = 'No candles in selected date range';
        if (request.skipMissingSymbols) {
          skipped.push({ strategyId: Number(strategy.id), strategyName: strategy.name, reason });
          continue;
        }
        throw new Error(`Strategy ${strategy.name}: ${reason}`);
      }
    }

    let lastInRangeIndex = candles.length - 1;
    if (request.dateToMs !== null) {
      for (let idx = candles.length - 1; idx >= 0; idx -= 1) {
        if (candles[idx].timeMs <= request.dateToMs) {
          lastInRangeIndex = idx;
          break;
        }
      }
    }

    const startIndex = Math.max(length, firstInRangeIndex + warmupBars);
    const endIndex = Math.min(candles.length - 1, lastInRangeIndex);

    if (endIndex <= startIndex) {
      const reason = 'No executable candles after warmup in selected date range';
      if (request.skipMissingSymbols) {
        skipped.push({ strategyId: Number(strategy.id), strategyName: strategy.name, reason });
        continue;
      }
      throw new Error(`Strategy ${strategy.name}: ${reason}`);
    }

    runtimes.push({
      strategy,
      candles,
      currentPrice: candles[startIndex].close,
      state: 'flat',
      entryPrice: null,
      tpAnchorPrice: null,
      notional: 0,
      openTrade: null,
      startIndex,
      endIndex,
    });
  }

  return {
    runtimes,
    skipped,
  };
};

const normalizeRequest = (raw: BacktestRunRequest): NormalizedBacktestRequest => {
  const mode: BacktestMode = raw.mode === 'portfolio' ? 'portfolio' : 'single';
  const bars = Math.max(120, Math.floor(asNumber(raw.bars, 1200)));
  const warmupBars = Math.max(0, Math.min(5000, Math.floor(asNumber(raw.warmupBars, 0))));
  const initialBalance = Math.max(10, asNumber(raw.initialBalance, 1000));
  const commissionPercent = clamp(asNumber(raw.commissionPercent, 0.06), 0, 5);
  const slippagePercent = clamp(asNumber(raw.slippagePercent, 0.03), 0, 5);
  const fundingRatePercent = clamp(asNumber(raw.fundingRatePercent, 0), -5, 5);
  const dateFromMs = parseTimestampMs(raw.dateFrom);
  const dateToMs = parseTimestampMs(raw.dateTo);

  if (dateFromMs !== null && dateToMs !== null && dateToMs <= dateFromMs) {
    throw new Error('dateTo must be later than dateFrom');
  }

  return {
    apiKeyName: String(raw.apiKeyName || '').trim(),
    mode,
    strategyId: Number.isFinite(Number(raw.strategyId)) ? Number(raw.strategyId) : 0,
    strategyIds: Array.isArray(raw.strategyIds)
      ? raw.strategyIds.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0)
      : [],
    bars,
    dateFromMs,
    dateToMs,
    warmupBars,
    skipMissingSymbols: raw.skipMissingSymbols === true,
    initialBalance,
    commissionPercent,
    slippagePercent,
    fundingRatePercent,
  };
};

const pickStrategiesForRequest = async (request: NormalizedBacktestRequest): Promise<Strategy[]> => {
  const all = await getStrategies(request.apiKeyName, {
    includeLotPreview: false,
  });

  if (request.mode === 'single') {
    const id = request.strategyId;
    if (!Number.isFinite(id) || id <= 0) {
      throw new Error('strategyId is required for single mode');
    }

    const found = all.find((item) => Number(item.id) === id);
    if (!found) {
      throw new Error(`Strategy ${id} not found for api key ${request.apiKeyName}`);
    }

    return [found];
  }

  const ids = request.strategyIds;
  if (ids.length === 0) {
    throw new Error('strategyIds[] is required for portfolio mode');
  }

  const uniqueIds = Array.from(new Set(ids));
  const selected = all.filter((item) => uniqueIds.includes(Number(item.id)));

  if (selected.length !== uniqueIds.length) {
    const foundIds = selected.map((item) => Number(item.id));
    const missing = uniqueIds.filter((id) => !foundIds.includes(id));
    throw new Error(`Strategies not found for api key ${request.apiKeyName}: ${missing.join(', ')}`);
  }

  return selected;
};

export const runBacktest = async (rawRequest: BacktestRunRequest): Promise<BacktestRunResult> => {
  const request = normalizeRequest(rawRequest);
  if (!request.apiKeyName) {
    throw new Error('apiKeyName is required');
  }

  const strategies = await pickStrategiesForRequest(request);
  const runtimeLoad = await loadRuntimeStrategies(request, strategies);
  const runtimes = runtimeLoad.runtimes;

  if (runtimes.length === 0) {
    if (runtimeLoad.skipped.length > 0) {
      throw new Error(`No runnable strategies in selected range. Skipped: ${runtimeLoad.skipped.map((item) => `#${item.strategyId} ${item.reason}`).join('; ')}`);
    }
    throw new Error('No runnable strategies for backtest');
  }

  const events = buildEvents(runtimes);

  if (events.length === 0) {
    throw new Error('No strategy events available for backtest');
  }

  const ctx: BacktestContext = {
    cashEquity: request.initialBalance,
    commissionRate: request.commissionPercent / 100,
    slippageRate: request.slippagePercent / 100,
    fundingRate: request.fundingRatePercent / 100,
    trades: [],
  };

  const equityCurve: BacktestPoint[] = [];
  let peak = request.initialBalance;
  let maxDrawdownAbsolute = 0;
  let maxDrawdownPercent = 0;

  const pushEquityPoint = (timeMs: number) => {
    const value = portfolioEquity(ctx.cashEquity, runtimes);
    equityCurve.push({
      time: Math.floor(timeMs / 1000),
      equity: value,
    });

    peak = Math.max(peak, value);
    const drawdownAbs = peak - value;
    const drawdownPct = peak > 0 ? (drawdownAbs / peak) * 100 : 0;

    maxDrawdownAbsolute = Math.max(maxDrawdownAbsolute, drawdownAbs);
    maxDrawdownPercent = Math.max(maxDrawdownPercent, drawdownPct);
  };

  let processedEvents = 0;

  for (const event of events) {
    processedEvents += 1;
    await maybeYieldByCounter(processedEvents, 250);

    const runtime = runtimes[event.strategyIndex];
    const strategy = runtime.strategy;
    const strategyType = normalizeStrategyType(strategy.strategy_type);
    const candle = runtime.candles[event.candleIndex];
    runtime.currentPrice = candle.close;

    applyFunding(ctx, runtime);

    const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
    const zscoreEntry = normalizeZscoreEntry(strategy.zscore_entry);
    const signalPayload = computeSignalAtIndex(
      strategyType,
      runtime.candles,
      event.candleIndex,
      length,
      strategy.detection_source,
      zscoreEntry,
      strategy.long_enabled,
      strategy.short_enabled
    );

    const isStatArb = strategyType === 'stat_arb_zscore';
    const zscoreExit = normalizeZscoreExit(strategy.zscore_exit, zscoreEntry);
    const zscoreStop = normalizeZscoreStop(strategy.zscore_stop, zscoreEntry);
    const state = runtime.state;
    const entryPrice = runtime.entryPrice;
    const takeProfitPercent = Math.max(0, asNumber(strategy.take_profit_percent, 0));

    let closedOnCurrentBar = false;

    if (isStatArb) {
      const hasZScore = Number.isFinite(signalPayload.zScore);

      if (state === 'long' && hasZScore && Number(signalPayload.zScore) <= -zscoreStop) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'zscore_stop_long');
        closedOnCurrentBar = true;
      }

      if (!closedOnCurrentBar && state === 'short' && hasZScore && Number(signalPayload.zScore) >= zscoreStop) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'zscore_stop_short');
        closedOnCurrentBar = true;
      }

      if (!closedOnCurrentBar && state === 'long' && hasZScore && Number(signalPayload.zScore) >= -zscoreExit) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'mean_revert_exit_long');
        closedOnCurrentBar = true;
      }

      if (!closedOnCurrentBar && state === 'short' && hasZScore && Number(signalPayload.zScore) <= zscoreExit) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'mean_revert_exit_short');
        closedOnCurrentBar = true;
      }
    } else {
      if (state === 'long' && takeProfitPercent > 0) {
        const existingAnchor = Number(runtime.tpAnchorPrice);
        const anchorBase = Number.isFinite(existingAnchor) && existingAnchor > 0
          ? existingAnchor
          : (entryPrice && entryPrice > 0 ? entryPrice : signalPayload.current);

        const nextAnchor = Math.max(anchorBase, signalPayload.current);
        runtime.tpAnchorPrice = nextAnchor;

        const trailingStop = nextAnchor * (1 - takeProfitPercent / 100);
        if (Number.isFinite(trailingStop) && signalPayload.current <= trailingStop) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'take_profit_long');
          closedOnCurrentBar = true;
        }
      }

      if (!closedOnCurrentBar && state === 'short' && takeProfitPercent > 0) {
        const existingAnchor = Number(runtime.tpAnchorPrice);
        const anchorBase = Number.isFinite(existingAnchor) && existingAnchor > 0
          ? existingAnchor
          : (entryPrice && entryPrice > 0 ? entryPrice : signalPayload.current);

        const nextAnchor = Math.min(anchorBase, signalPayload.current);
        runtime.tpAnchorPrice = nextAnchor;

        const trailingStop = nextAnchor * (1 + takeProfitPercent / 100);
        if (Number.isFinite(trailingStop) && signalPayload.current >= trailingStop) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'take_profit_short');
          closedOnCurrentBar = true;
        }
      }

      if (!closedOnCurrentBar && state === 'long' && entryPrice && signalPayload.current <= signalPayload.donchianCenter) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'stop_loss_long_center');
        closedOnCurrentBar = true;
      }

      if (!closedOnCurrentBar && state === 'short' && entryPrice && signalPayload.current >= signalPayload.donchianCenter) {
        closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'stop_loss_short_center');
        closedOnCurrentBar = true;
      }
    }

    if (signalPayload.signal === 'none') {
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state === signalPayload.signal) {
      pushEquityPoint(event.timeMs);
      continue;
    }

    if (state !== 'flat') {
      closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'signal_flip');
    }

    const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, equityNow);
    pushEquityPoint(event.timeMs);
  }

  const lastTime = events[events.length - 1].timeMs;
  for (const runtime of runtimes) {
    if (runtime.state !== 'flat') {
      const lastCandle = runtime.candles[runtime.candles.length - 1];
      runtime.currentPrice = lastCandle.close;
      closePosition(
        ctx,
        runtime,
        Number(runtime.strategy.id),
        runtime.strategy.name,
        lastCandle.timeMs,
        lastCandle.close,
        'end_of_test'
      );
    }
  }

  pushEquityPoint(lastTime + 1000);

  const finalEquity = portfolioEquity(ctx.cashEquity, runtimes);

  const wins = ctx.trades.filter((trade) => trade.netPnl > 0).length;
  const tradesCount = ctx.trades.length;
  const winRatePercent = tradesCount > 0 ? (wins / tradesCount) * 100 : 0;

  const grossProfit = ctx.trades
    .filter((trade) => trade.netPnl > 0)
    .reduce((sum, trade) => sum + trade.netPnl, 0);

  const grossLoss = Math.abs(
    ctx.trades
      .filter((trade) => trade.netPnl < 0)
      .reduce((sum, trade) => sum + trade.netPnl, 0)
  );

  const profitFactor = grossLoss > 0
    ? grossProfit / grossLoss
    : grossProfit > 0
      ? 999
      : 0;

  const strategyIds = runtimes.map((item) => Number(item.strategy.id));
  const strategyNames = runtimes.map((item) => item.strategy.name);

  const uniqueIntervals = Array.from(new Set(runtimes.map((item) => String(item.strategy.interval || '1h'))));
  const interval = uniqueIntervals.length === 1 ? uniqueIntervals[0] : 'mixed';

  const summary: BacktestSummary = {
    mode: request.mode,
    apiKeyName: request.apiKeyName,
    strategyIds,
    strategyNames,
    interval,
    barsRequested: request.bars,
    barsProcessed: events.length,
    dateFromMs: request.dateFromMs,
    dateToMs: request.dateToMs,
    warmupBars: request.warmupBars,
    skippedStrategies: runtimeLoad.skipped.length,
    processedStrategies: runtimes.length,
    initialBalance: request.initialBalance,
    finalEquity,
    totalReturnPercent: request.initialBalance > 0 ? ((finalEquity / request.initialBalance) - 1) * 100 : 0,
    maxDrawdownPercent,
    maxDrawdownAbsolute,
    tradesCount,
    winRatePercent,
    profitFactor,
    grossProfit,
    grossLoss,
    commissionPercent: request.commissionPercent,
    slippagePercent: request.slippagePercent,
    fundingRatePercent: request.fundingRatePercent,
  };

  const requestEcho: BacktestRunRequest = {
    apiKeyName: request.apiKeyName,
    mode: request.mode,
    strategyId: request.mode === 'single' ? request.strategyId : undefined,
    strategyIds: request.mode === 'portfolio' ? request.strategyIds : undefined,
    bars: request.bars,
    dateFrom: request.dateFromMs ?? undefined,
    dateTo: request.dateToMs ?? undefined,
    warmupBars: request.warmupBars,
    skipMissingSymbols: request.skipMissingSymbols,
    initialBalance: request.initialBalance,
    commissionPercent: request.commissionPercent,
    slippagePercent: request.slippagePercent,
    fundingRatePercent: request.fundingRatePercent,
  };

  return {
    request: requestEcho,
    summary,
    equityCurve,
    trades: ctx.trades,
  };
};

const escapeHtml = (value: any): string => {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
};

const renderBacktestReportHtml = (runId: number, result: BacktestRunResult): string => {
  const summary = result.summary;
  const tradesRows = result.trades
    .map((trade) => {
      return `<tr>
  <td>${escapeHtml(trade.strategyId)}</td>
  <td>${escapeHtml(trade.strategyName)}</td>
  <td>${escapeHtml(trade.side)}</td>
  <td>${escapeHtml(new Date(trade.entryTime).toISOString())}</td>
  <td>${escapeHtml(new Date(trade.exitTime).toISOString())}</td>
  <td>${escapeHtml(trade.entryPrice.toFixed(6))}</td>
  <td>${escapeHtml(trade.exitPrice.toFixed(6))}</td>
  <td>${escapeHtml(trade.notional.toFixed(2))}</td>
  <td>${escapeHtml(trade.netPnl.toFixed(2))}</td>
  <td>${escapeHtml(trade.pnlPercent.toFixed(3))}%</td>
  <td>${escapeHtml(trade.reason)}</td>
</tr>`;
    })
    .join('\n');

  const equityRows = result.equityCurve
    .slice(-500)
    .map((point) => `<tr><td>${escapeHtml(new Date(point.time * 1000).toISOString())}</td><td>${escapeHtml(point.equity.toFixed(2))}</td></tr>`)
    .join('\n');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Backtest Report #${escapeHtml(runId)}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; color: #111827; }
    h1, h2 { margin: 8px 0 12px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 8px; margin-bottom: 16px; }
    .card { border: 1px solid #d1d5db; border-radius: 8px; padding: 10px; background: #f9fafb; }
    table { border-collapse: collapse; width: 100%; margin-top: 8px; font-size: 12px; }
    th, td { border: 1px solid #d1d5db; padding: 6px; text-align: left; }
    th { background: #f3f4f6; }
  </style>
</head>
<body>
  <h1>Backtest Report #${escapeHtml(runId)}</h1>
  <div>Generated: ${escapeHtml(new Date().toISOString())}</div>
  <div>API key: <strong>${escapeHtml(summary.apiKeyName)}</strong> | Mode: <strong>${escapeHtml(summary.mode)}</strong></div>
  <div>Strategies: ${escapeHtml(summary.strategyNames.join(', '))}</div>

  <div class="grid">
    <div class="card"><strong>Initial</strong><br/>${escapeHtml(summary.initialBalance.toFixed(2))}</div>
    <div class="card"><strong>Final</strong><br/>${escapeHtml(summary.finalEquity.toFixed(2))}</div>
    <div class="card"><strong>Return</strong><br/>${escapeHtml(summary.totalReturnPercent.toFixed(3))}%</div>
    <div class="card"><strong>Max DD</strong><br/>${escapeHtml(summary.maxDrawdownPercent.toFixed(3))}%</div>
    <div class="card"><strong>Trades</strong><br/>${escapeHtml(summary.tradesCount)}</div>
    <div class="card"><strong>Win Rate</strong><br/>${escapeHtml(summary.winRatePercent.toFixed(3))}%</div>
    <div class="card"><strong>Profit Factor</strong><br/>${escapeHtml(summary.profitFactor.toFixed(3))}</div>
    <div class="card"><strong>Bars Processed</strong><br/>${escapeHtml(summary.barsProcessed)}</div>
  </div>

  <h2>Trades</h2>
  <table>
    <thead>
      <tr>
        <th>ID</th><th>Strategy</th><th>Side</th><th>Entry</th><th>Exit</th><th>Entry Px</th><th>Exit Px</th><th>Notional</th><th>Net PnL</th><th>PnL %</th><th>Reason</th>
      </tr>
    </thead>
    <tbody>
      ${tradesRows || '<tr><td colspan="11">No trades</td></tr>'}
    </tbody>
  </table>

  <h2>Equity Curve (last 500 points)</h2>
  <table>
    <thead><tr><th>Time</th><th>Equity</th></tr></thead>
    <tbody>
      ${equityRows || '<tr><td colspan="2">No points</td></tr>'}
    </tbody>
  </table>
</body>
</html>`;
};

const saveBacktestReportFile = async (runId: number, result: BacktestRunResult): Promise<string> => {
  const reportsDir = path.join(process.cwd(), 'logs', 'backtests');
  await fs.promises.mkdir(reportsDir, { recursive: true });

  const filePath = path.join(reportsDir, `backtest_run_${runId}.html`);
  const html = renderBacktestReportHtml(runId, result);
  await fs.promises.writeFile(filePath, html, 'utf-8');
  return filePath;
};

export const saveBacktestRun = async (result: BacktestRunResult): Promise<number> => {
  const summary = result.summary;

  const insert: any = await db.run(
    `INSERT INTO backtest_runs (
      api_key_name,
      mode,
      strategy_ids,
      strategy_names,
      interval,
      bars,
      initial_balance,
      final_equity,
      total_return_percent,
      max_drawdown_percent,
      trades_count,
      win_rate_percent,
      profit_factor,
      commission_percent,
      slippage_percent,
      funding_rate_percent,
      request_json,
      summary_json,
      equity_curve_json,
      trades_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      summary.apiKeyName,
      summary.mode,
      JSON.stringify(summary.strategyIds),
      JSON.stringify(summary.strategyNames),
      summary.interval,
      summary.barsRequested,
      summary.initialBalance,
      summary.finalEquity,
      summary.totalReturnPercent,
      summary.maxDrawdownPercent,
      summary.tradesCount,
      summary.winRatePercent,
      summary.profitFactor,
      summary.commissionPercent,
      summary.slippagePercent,
      summary.fundingRatePercent,
      JSON.stringify(result.request),
      JSON.stringify(result.summary),
      JSON.stringify(result.equityCurve),
      JSON.stringify(result.trades),
    ]
  );

  const runId = Number(insert?.lastID || 0);
  if (runId > 0) {
    try {
      const reportPath = await saveBacktestReportFile(runId, result);
      logger.info(`Backtest report saved: ${reportPath}`);
    } catch (error) {
      const err = error as Error;
      logger.warn(`Failed to save backtest report file for run ${runId}: ${err.message}`);
    }
  }

  return runId;
};

const parseJsonArray = <T>(value: any, fallback: T[]): T[] => {
  try {
    const parsed = JSON.parse(String(value || '[]'));
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
};

const parseJsonObject = <T>(value: any, fallback: T): T => {
  try {
    const parsed = JSON.parse(String(value || '{}'));
    return parsed as T;
  } catch {
    return fallback;
  }
};

export const listBacktestRuns = async (limit: number = 20, apiKeyName?: string): Promise<BacktestRunListItem[]> => {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(asNumber(limit, 20))));

  const rows = apiKeyName
    ? await db.all(
      `SELECT * FROM backtest_runs WHERE api_key_name = ? ORDER BY id DESC LIMIT ?`,
      [apiKeyName, safeLimit]
    )
    : await db.all(
      `SELECT * FROM backtest_runs ORDER BY id DESC LIMIT ?`,
      [safeLimit]
    );

  return (Array.isArray(rows) ? rows : []).map((row: any) => ({
    id: Number(row.id),
    created_at: String(row.created_at || ''),
    api_key_name: String(row.api_key_name || ''),
    mode: String(row.mode || 'single') === 'portfolio' ? 'portfolio' : 'single',
    strategy_ids: parseJsonArray<number>(row.strategy_ids, []),
    strategy_names: parseJsonArray<string>(row.strategy_names, []),
    interval: String(row.interval || ''),
    bars: asNumber(row.bars, 0),
    initial_balance: asNumber(row.initial_balance, 0),
    final_equity: asNumber(row.final_equity, 0),
    total_return_percent: asNumber(row.total_return_percent, 0),
    max_drawdown_percent: asNumber(row.max_drawdown_percent, 0),
    trades_count: Math.floor(asNumber(row.trades_count, 0)),
    win_rate_percent: asNumber(row.win_rate_percent, 0),
    profit_factor: asNumber(row.profit_factor, 0),
  }));
};

export const getBacktestRun = async (id: number): Promise<BacktestRunResult | null> => {
  const runId = Math.floor(asNumber(id, 0));
  if (!Number.isFinite(runId) || runId <= 0) {
    return null;
  }

  const row: any = await db.get(`SELECT * FROM backtest_runs WHERE id = ?`, [runId]);
  if (!row) {
    return null;
  }

  const request = parseJsonObject<BacktestRunRequest>(row.request_json, {
    apiKeyName: String(row.api_key_name || ''),
  });

  const summary = parseJsonObject<BacktestSummary>(row.summary_json, {
    mode: String(row.mode || 'single') === 'portfolio' ? 'portfolio' : 'single',
    apiKeyName: String(row.api_key_name || ''),
    strategyIds: parseJsonArray<number>(row.strategy_ids, []),
    strategyNames: parseJsonArray<string>(row.strategy_names, []),
    interval: String(row.interval || ''),
    barsRequested: asNumber(row.bars, 0),
    barsProcessed: 0,
    dateFromMs: null,
    dateToMs: null,
    warmupBars: 0,
    skippedStrategies: 0,
    processedStrategies: parseJsonArray<number>(row.strategy_ids, []).length,
    initialBalance: asNumber(row.initial_balance, 0),
    finalEquity: asNumber(row.final_equity, 0),
    totalReturnPercent: asNumber(row.total_return_percent, 0),
    maxDrawdownPercent: asNumber(row.max_drawdown_percent, 0),
    maxDrawdownAbsolute: 0,
    tradesCount: Math.floor(asNumber(row.trades_count, 0)),
    winRatePercent: asNumber(row.win_rate_percent, 0),
    profitFactor: asNumber(row.profit_factor, 0),
    grossProfit: 0,
    grossLoss: 0,
    commissionPercent: asNumber(row.commission_percent, 0),
    slippagePercent: asNumber(row.slippage_percent, 0),
    fundingRatePercent: asNumber(row.funding_rate_percent, 0),
  });

  const equityCurve = parseJsonArray<BacktestPoint>(row.equity_curve_json, []);
  const trades = parseJsonArray<BacktestTrade>(row.trades_json, []);

  return {
    runId,
    request,
    summary,
    equityCurve,
    trades,
  };
};

export const deleteBacktestRun = async (id: number): Promise<boolean> => {
  const runId = Math.floor(asNumber(id, 0));
  if (!Number.isFinite(runId) || runId <= 0) {
    return false;
  }

  const result: any = await db.run('DELETE FROM backtest_runs WHERE id = ?', [runId]);

  const reportPath = path.join(process.cwd(), 'logs', 'backtests', `backtest_run_${runId}.html`);
  try {
    await fs.promises.unlink(reportPath);
  } catch {
    // Report file is optional and may be absent.
  }

  return Number(result?.changes || 0) > 0;
};

import { MarketMode, Strategy, StrategyType } from '../config/settings';
import { getStrategies } from '../bot/strategy';
import { getMarketData, getExchangeForApiKey } from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { db } from '../utils/database';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { computeChannelWidthLotMultiplier } from '../services/strategy/sizing';

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
  maxOpenPositions: number;
  skippedByPositionLimit: number;
  /** Number of entries skipped because another strategy holds the same pair (mirrors runtime pair-lock). */
  skippedByPairLock: number;
  /** Earliest candle timestamp actually used across all runtime strategies (ms). */
  actualDataStartMs: number | null;
  /** Latest candle timestamp actually used across all runtime strategies (ms). */
  actualDataEndMs: number | null;
};

export type BacktestRunRequest = {
  apiKeyName: string;
  /**
   * Optional override for which API key is used to fetch candle data.
   * When unset, falls back to apiKeyName. Used by sweep fan-out so the strategy
   * can be looked up on the master key while candles come from a different
   * exchange's key.
   */
  dataApiKeyName?: string;
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
  maxOpenPositions?: number;
  /** Override max_deposit on all strategies (scales position sizing to match initialBalance). */
  maxDepositOverride?: number;
  /** Override lot_long_percent / lot_short_percent on all strategies. */
  lotPercentOverride?: number;
  /**
   * Per-strategy multiplier applied to lot_long_percent / lot_short_percent
   * (or to lotPercentOverride when set). Used by trading-system backtests to
   * apply per-member weights from the storefront card. Missing entries default
   * to 1.0 (no change). Values are clamped to [0, 10].
   */
  lotPercentMultiplierByStrategyId?: Record<string | number, number>;
  /** Override reinvest_percent on all strategies (0..100). Use -1 / undefined to keep per-strategy DB value. */
  reinvestPercentOverride?: number;
  /**
   * Partial take-profit: when a position reaches this PnL% threshold, close 50%
   * at market and set break-even anchor on the remainder (0 = disabled).
   */
  partialTpPct?: number;
  /** When true, scale trend lot by inverse Donchian channel width at entry. */
  autoLotByChannelWidth?: boolean;
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
  dataApiKeyName: string;
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
  maxOpenPositions: number;
  maxDepositOverride: number;
  lotPercentOverride: number;
  lotPercentMultiplierByStrategyId: Map<number, number>;
  reinvestPercentOverride: number;
  partialTpPct: number;
  autoLotByChannelWidth: boolean;
  /**
   * If true (default), mirror runtime pair-lock semantics in the backtest engine.
   * Only one strategy can hold a position on a given pair at a time.
   * Within a single bar, the strategy that gets to enter is chosen via
   * a seeded random tie-break (see `pairLockSeed`).
   */
  enablePairLock: boolean;
  /**
   * Seed for the deterministic RNG used to break ties when multiple strategies
   * fire on the same timestamp. Same seed → reproducible result.
   */
  pairLockSeed: number;
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

// Reinvest share: 0 (no compounding) .. 1 (full compounding). Values >100% in
// reinvest_percent are clamped to 1 (full compound) — historically reinvest_percent
// was a multiplicative size hack (200% = 2x lot) but no live strategy uses that
// semantic (all rows are 0). Treat reinvest_percent strictly as a 0..100% knob.
const clampReinvestShare = (reinvestPercent: number): number => {
  const safe = Number.isFinite(reinvestPercent) ? reinvestPercent : 0;
  return Math.min(1, Math.max(0, safe / 100));
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

/** YYYY-MM-DD dateTo should include the full calendar day, not 00:00:00. */
const parseDateToMs = (value: unknown): number | null => {
  const text = String(value ?? '').trim();
  const baseMs = parseTimestampMs(value);
  if (baseMs === null) {
    return null;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    return baseMs + 86400000 - 1;
  }
  return baseMs;
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

/**
 * HiDeep oscillator signal:
 * - mac1 = price_channel_length (SMA period for center, default 10)
 * - up1/dn1 = zscore_entry (fast RSI period, default 2)
 * - sma1 = zscore_stop (deviation SMA period, default 100)
 *
 * fastRSI = RSI(close, up1)
 * MAC1 = SMA(close, mac1)
 * len1 = |close - MAC1|
 * SMA1 = SMA(len1, sma1)
 *
 * LONG entry:  close < open  AND  len1 > SMA1  AND  fastRSI < 10
 * SHORT entry: close > open  AND  len1 > SMA1  AND  fastRSI > 90
 *
 * donchianCenter = MAC1 (used for trail/center-cross exit)
 * zScore = fastRSI (used for exit logic: >90 for long exit, <10 for short exit)
 */
const computeHiDeepSignalAtIndex = (
  candles: ParsedCandle[],
  index: number,
  mac1: number,       // price_channel_length
  rsiPeriod: number,  // zscore_entry (up1/dn1)
  longEnabled: boolean,
  shortEnabled: boolean
): BacktestSignalPayload => {
  // Need enough candles for SMA1 (sma1=100 default), but we use a simpler
  // fallback: require mac1 + rsiPeriod bars minimum. sma1 period is fixed 100.
  const sma1Period = 100;
  const needed = Math.max(mac1, sma1Period, rsiPeriod + 1);
  if (index < needed || index >= candles.length) {
    throw new Error(`HiDeep: not enough candles at index ${index}, need ${needed}`);
  }

  const current = candles[index];

  // MAC1 = SMA(close, mac1)
  const mac1Window = candles.slice(index - mac1, index + 1).map((c) => c.close);
  const mac1Val = mac1Window.reduce((s, v) => s + v, 0) / mac1Window.length;

  // len1 = |current.close - MAC1|
  const len1 = Math.abs(current.close - mac1Val);

  // SMA1 = SMA(len1_series, sma1Period) — compute over last sma1Period bars
  const deviations: number[] = [];
  const macWindow2 = candles.slice(index - mac1 - sma1Period + 1, index + 1);
  for (let i = mac1 - 1; i < macWindow2.length; i++) {
    const slice = macWindow2.slice(i - mac1 + 1, i + 1);
    const sliceMac = slice.reduce((s, c) => s + c.close, 0) / slice.length;
    deviations.push(Math.abs(macWindow2[i].close - sliceMac));
  }
  const sma1Val = deviations.length > 0
    ? deviations.reduce((s, v) => s + v, 0) / deviations.length
    : 0;

  // Fast RSI (Wilder's RSI) with period rsiPeriod
  const rsiWindow = candles.slice(index - rsiPeriod - 1, index + 1);
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = 1; i < rsiWindow.length; i++) {
    const diff = rsiWindow[i].close - rsiWindow[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  const n = Math.max(1, rsiWindow.length - 1);
  avgGain /= n;
  avgLoss /= n;
  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const fastRsi = 100 - 100 / (1 + rs);

  const isOversold = fastRsi < 10;
  const isOverbought = fastRsi > 90;
  const hasMomentum = len1 > sma1Val && sma1Val > 0;
  const isBearCandle = current.close < current.open;
  const isBullCandle = current.close > current.open;

  if (longEnabled && isBearCandle && hasMomentum && isOversold) {
    return { signal: 'long', current: current.close, donchianCenter: mac1Val, zScore: fastRsi };
  }

  if (shortEnabled && isBullCandle && hasMomentum && isOverbought) {
    return { signal: 'short', current: current.close, donchianCenter: mac1Val, zScore: fastRsi };
  }

  return { signal: 'none', current: current.close, donchianCenter: mac1Val, zScore: fastRsi };
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

  if (strategyType === 'hideep') {
    return computeHiDeepSignalAtIndex(candles, index, length, zscoreEntry, longEnabled, shortEnabled);
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

const computeRsiAtIndex = (candles: ParsedCandle[], index: number, period: number): number => {
  const rsiPeriod = Math.max(2, Math.floor(period));
  if (index < rsiPeriod) {
    return 50;
  }
  const rsiWindow = candles.slice(index - rsiPeriod, index + 1);
  let gains = 0;
  let losses = 0;
  for (let i = 1; i < rsiWindow.length; i++) {
    const diff = rsiWindow[i].close - rsiWindow[i - 1].close;
    if (diff >= 0) gains += diff;
    else losses -= diff;
  }
  const n = Math.max(1, rsiWindow.length - 1);
  const avgGain = gains / n;
  const avgLoss = losses / n;
  if (avgLoss <= 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const extractDcaConfigFromStrategy = (s: any): {
  enabled: boolean; baseAmountUsdt: number; stepPercent: number; maxOrders: number;
  orderMultiplier: number; tpPercent: number; slPercent: number;
  perLegSl: boolean;
  entryFilter: 'always' | 'rsi_dip' | 'cooldown';
  reentryCooldownBars: number;
  rsiPeriod: number;
  rsiMax: number;
  barsSinceFlat: number;
  legs: Array<{ price: number; qty: number; invested: number; isBase: boolean }>;
  ordersCount: number; totalInvested: number; totalQty: number; lastBuyPrice: number;
} | null => {
  const t = String(s.strategy_type || '').trim().toLowerCase();
  if (t !== 'dca') return null;
  const ba = Number(s.dca_base_amount_usdt || 10);
  if (!Number.isFinite(ba) || ba <= 0) return null;
  const rawFilter = String(s.dca_entry_filter || 'always').trim().toLowerCase();
  const entryFilter = rawFilter === 'rsi_dip' || rawFilter === 'cooldown' ? rawFilter : 'always';
  return {
    enabled: true,
    baseAmountUsdt: Math.max(1, ba),
    stepPercent: Math.max(0.1, Number(s.dca_step_percent || 2)),
    maxOrders: Math.max(0, Math.floor(Number(s.dca_max_orders || 5))),
    orderMultiplier: Math.max(1, Number(s.dca_order_multiplier || 1)),
    tpPercent: Math.max(0.1, Number(s.dca_tp_percent || 3)),
    slPercent: Math.max(0, Number(s.dca_sl_percent || 0)),
    perLegSl: Number(s.dca_per_leg_sl || 0) === 1,
    entryFilter,
    reentryCooldownBars: Math.max(0, Math.floor(Number(s.dca_reentry_bars || 0))),
    rsiPeriod: Math.max(2, Math.floor(Number(s.dca_rsi_period || 14))),
    rsiMax: Math.max(5, Math.min(95, Number(s.dca_rsi_max || 45))),
    barsSinceFlat: 0,
    legs: [],
    ordersCount: 0, totalInvested: 0, totalQty: 0, lastBuyPrice: 0,
  };
};

const passesClassicDcaEntryFilter = (
  dc: NonNullable<ReturnType<typeof extractDcaConfigFromStrategy>>,
  candles: ParsedCandle[],
  index: number,
): boolean => {
  if (dc.entryFilter === 'cooldown') {
    return dc.barsSinceFlat >= dc.reentryCooldownBars;
  }
  if (dc.entryFilter === 'rsi_dip') {
    return computeRsiAtIndex(candles, index, dc.rsiPeriod) <= dc.rsiMax;
  }
  return true;
};

type DcaLegState = { price: number; qty: number; invested: number; isBase: boolean };

const syncDcaRuntimeFromLegs = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  dc: NonNullable<RuntimeStrategy['dcaState']>,
): void => {
  const legs = dc.legs;
  if (legs.length === 0) {
    runtime.state = 'flat';
    runtime.entryPrice = null;
    runtime.tpAnchorPrice = null;
    runtime.notional = 0;
    runtime.openTrade = null;
    runtime.partialTpTriggered = false;
    dc.ordersCount = 0;
    dc.totalInvested = 0;
    dc.totalQty = 0;
    dc.lastBuyPrice = 0;
    return;
  }
  dc.totalInvested = legs.reduce((sum, leg) => sum + leg.invested, 0);
  dc.totalQty = legs.reduce((sum, leg) => sum + leg.qty, 0);
  dc.ordersCount = legs.filter((leg) => !leg.isBase).length;
  dc.lastBuyPrice = legs[legs.length - 1].price;
  const avgEntry = dc.totalQty > 0 ? dc.totalInvested / dc.totalQty : 0;
  runtime.entryPrice = avgEntry;
  runtime.notional = dc.totalInvested;
  if (runtime.openTrade) {
    runtime.openTrade.entryPrice = avgEntry;
    runtime.openTrade.notional = dc.totalInvested;
  }
  ctx.lockedMargin = Math.max(0, ctx.lockedMargin);
};

const closeDcaLeg = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  strategyId: number,
  strategyName: string,
  exitTime: number,
  marketPrice: number,
  leg: DcaLegState,
  reason: string,
): void => {
  if (!runtime.openTrade || runtime.notional <= 0 || leg.invested <= 0) {
    return;
  }
  const side = runtime.openTrade.side;
  const exitPrice = executionPrice(marketPrice, side, 'exit', effectiveSlippageRate(ctx, runtime.strategy));
  const grossPnl = leg.invested * ((exitPrice / leg.price) - 1);
  const exitFee = leg.invested * effectiveCommissionRate(ctx, runtime.strategy);
  const entryFeeShare = runtime.openTrade.entryFee * (leg.invested / runtime.notional);
  const fundingShare = runtime.openTrade.funding * (leg.invested / runtime.notional);
  ctx.cashEquity += grossPnl - exitFee;
  ctx.lockedMargin = Math.max(0, ctx.lockedMargin - leg.invested);
  const netPnl = grossPnl - entryFeeShare - exitFee + fundingShare;
  const pnlPercent = leg.price > 0 ? ((exitPrice / leg.price) - 1) * 100 : 0;
  ctx.trades.push({
    strategyId,
    strategyName,
    side,
    entryTime: runtime.openTrade.entryTime,
    exitTime,
    entryPrice: leg.price,
    exitPrice,
    notional: leg.invested,
    grossPnl,
    netPnl,
    pnlPercent,
    fees: entryFeeShare + exitFee,
    funding: fundingShare,
    reason,
  });
  runtime.openTrade = {
    ...runtime.openTrade,
    notional: runtime.openTrade.notional - leg.invested,
    entryFee: runtime.openTrade.entryFee - entryFeeShare,
    funding: runtime.openTrade.funding - fundingShare,
  };
  runtime.notional = runtime.openTrade.notional;
};

const resolveAutoLotChannelWidthMult = (
  runtime: RuntimeStrategy,
  candleIndex: number,
  strategy: Strategy,
  ctx: BacktestContext,
  signalPayload: BacktestSignalPayload,
): number => {
  const enabled = ctx.autoLotByChannelWidth || Number((strategy as any).auto_lot_by_channel_width || 0) === 1;
  if (!enabled) {
    return 1;
  }
  const high = signalPayload.donchianCenter > 0
    ? signalPayload.donchianCenter + (signalPayload.current - signalPayload.donchianCenter)
    : signalPayload.current;
  // Reconstruct approximate channel bounds from center when only center is in payload
  const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
  if (candleIndex >= length && candleIndex < runtime.candles.length) {
    const window = runtime.candles.slice(candleIndex - length, candleIndex);
    const source = String(strategy.detection_source || 'close').trim() === 'close' ? 'close' : 'hl';
    const highs = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.high);
    const lows = source === 'close' ? window.map((bar) => bar.close) : window.map((bar) => bar.low);
    const donchianHigh = Math.max(...highs);
    const donchianLow = Math.min(...lows);
    return computeChannelWidthLotMultiplier(
      donchianHigh,
      donchianLow,
      signalPayload.donchianCenter,
      strategy as any,
    );
  }
  return computeChannelWidthLotMultiplier(high, high, signalPayload.donchianCenter, strategy as any);
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
  /** Has the partial TP (50% close) already fired for the current open position? */
  partialTpTriggered: boolean;
  dcaState: ReturnType<typeof extractDcaConfigFromStrategy>;
};

type BacktestContext = {
  cashEquity: number;
  lockedMargin: number;
  commissionRate: number;
  slippageRate: number;
  fundingRate: number;
  trades: BacktestTrade[];
  maxDepositOverride: number;
  lotPercentOverride: number;
  lotPercentMultiplierByStrategyId: Map<number, number>;
  reinvestPercentOverride: number;
  initialBalance: number;
  autoLotByChannelWidth: boolean;
};

const computeLockedMargin = (runtimes: RuntimeStrategy[]): number => {
  return runtimes.reduce((sum, rt) => {
    if (rt.state === 'flat') return sum;
    const leverage = Math.max(1, asNumber(rt.strategy.leverage, 1));
    return sum + rt.notional / leverage;
  }, 0);
};

// Synthetic strategies execute as TWO real legs on the exchange (long base + short
// quote, or vice versa). Each leg pays its own commission and incurs its own
// slippage. To match runtime PnL, we double the effective rates for synthetic.
const isSyntheticStrategy = (strategy: any): boolean => {
  return String(strategy?.market_mode || '').trim() === 'synthetic';
};
const effectiveCommissionRate = (ctx: BacktestContext, strategy: any): number => {
  return isSyntheticStrategy(strategy) ? ctx.commissionRate * 2 : ctx.commissionRate;
};
const effectiveSlippageRate = (ctx: BacktestContext, strategy: any): number => {
  return isSyntheticStrategy(strategy) ? ctx.slippageRate * 2 : ctx.slippageRate;
};

const executionPrice = (price: number, side: 'long' | 'short', phase: 'entry' | 'exit', slippageRate: number): number => {
  if (!Number.isFinite(price) || price <= 0) {
    return price;  }

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
  const exitPrice = executionPrice(marketPrice, side, 'exit', effectiveSlippageRate(ctx, runtime.strategy));
  const entryPrice = runtime.openTrade.entryPrice;
  const notional = runtime.openTrade.notional;

  let grossPnl = 0;
  if (side === 'long') {
    grossPnl = notional * ((exitPrice / entryPrice) - 1);
  } else {
    grossPnl = notional * ((entryPrice / exitPrice) - 1);
  }

  const exitFee = notional * effectiveCommissionRate(ctx, runtime.strategy);
  ctx.cashEquity += grossPnl - exitFee;
  ctx.lockedMargin = Math.max(0, ctx.lockedMargin - notional);

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
  runtime.partialTpTriggered = false;
};

/**
 * Close a fraction (0..1] of the current position at market price.
 * Records a proportional trade, reduces notional & locked margin,
 * and keeps the position open for the remaining fraction.
 */
const partialClosePosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  strategyId: number,
  strategyName: string,
  exitTime: number,
  marketPrice: number,
  reason: string,
  fraction: number, // 0..1, e.g. 0.5 for 50%
): void => {
  if (!runtime.openTrade || !runtime.entryPrice || runtime.notional <= 0 || runtime.state === 'flat') {
    return;
  }

  const side = runtime.openTrade.side;
  const exitPrice = executionPrice(marketPrice, side, 'exit', effectiveSlippageRate(ctx, runtime.strategy));
  const entryPrice = runtime.openTrade.entryPrice;
  const closedNotional = runtime.openTrade.notional * fraction;

  let grossPnl = 0;
  if (side === 'long') {
    grossPnl = closedNotional * ((exitPrice / entryPrice) - 1);
  } else {
    grossPnl = closedNotional * ((entryPrice / exitPrice) - 1);
  }

  const exitFee = closedNotional * effectiveCommissionRate(ctx, runtime.strategy);
  const closedEntryFee = runtime.openTrade.entryFee * fraction;
  const closedFunding = runtime.openTrade.funding * fraction;

  ctx.cashEquity += grossPnl - exitFee;
  ctx.lockedMargin = Math.max(0, ctx.lockedMargin - closedNotional);

  const netPnl = grossPnl - closedEntryFee - exitFee + closedFunding;
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
    notional: closedNotional,
    grossPnl,
    netPnl,
    pnlPercent,
    fees: closedEntryFee + exitFee,
    funding: closedFunding,
    reason,
  });

  // Reduce the open trade to the remaining fraction
  const remainingFraction = 1 - fraction;
  runtime.openTrade = {
    ...runtime.openTrade,
    notional: runtime.openTrade.notional * remainingFraction,
    entryFee: runtime.openTrade.entryFee * remainingFraction,
    funding: runtime.openTrade.funding * remainingFraction,
  };
  runtime.notional = runtime.openTrade.notional;
};

const openPosition = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  signal: 'long' | 'short',
  eventTime: number,
  marketPrice: number,
  portfolioEquityNow: number,
  lotChannelWidthMult = 1,
): boolean => {
  const strategy = runtime.strategy;

  // DCA strategies: use baseAmountUsdt instead of lot percent
  if (runtime.dcaState?.enabled) {
    const dcaSize = runtime.dcaState.baseAmountUsdt;
    if (dcaSize <= 0) return false;
    const entryPrice = executionPrice(marketPrice, signal, 'entry', effectiveSlippageRate(ctx, strategy));
    const entryFee = dcaSize * effectiveCommissionRate(ctx, strategy);
    ctx.cashEquity -= entryFee;
    runtime.state = signal;
    runtime.entryPrice = entryPrice;
    runtime.tpAnchorPrice = marketPrice;
    runtime.notional = dcaSize;
    runtime.partialTpTriggered = false;
    runtime.openTrade = { side: signal, entryTime: eventTime, entryPrice, notional: dcaSize, entryFee, funding: 0 };
    ctx.lockedMargin += dcaSize;
    const qty = dcaSize / entryPrice;
    runtime.dcaState = {
      ...runtime.dcaState,
      ordersCount: 0,
      totalInvested: dcaSize,
      totalQty: qty,
      lastBuyPrice: entryPrice,
      legs: [{ price: entryPrice, qty, invested: dcaSize, isBase: true }],
    };
    return true;
  }

  const safeChannelMult = Number.isFinite(lotChannelWidthMult) && lotChannelWidthMult > 0 ? lotChannelWidthMult : 1;
  const baseLotPercent = ctx.lotPercentOverride > 0
    ? ctx.lotPercentOverride
    : signal === 'long'
      ? asNumber(strategy.lot_long_percent, 0)
      : asNumber(strategy.lot_short_percent, 0);

  // Per-strategy multiplier (e.g. trading-system member weight from storefront).
  const strategyId = Number((strategy as { id?: number | string })?.id);
  const multiplier = Number.isFinite(strategyId) && ctx.lotPercentMultiplierByStrategyId.has(strategyId)
    ? ctx.lotPercentMultiplierByStrategyId.get(strategyId) as number
    : 1;
  const lotPercent = baseLotPercent * multiplier * safeChannelMult;

  const lotFraction = Math.max(0, lotPercent) / 100;
  if (lotFraction <= 0) {
    return false;
  }

  const maxDeposit = ctx.maxDepositOverride > 0
    ? ctx.maxDepositOverride
    : asNumber(strategy.max_deposit, 0);

  // Reinvest semantics (matches user-facing setting on the storefront/admin panel):
  //   0%   → no compounding: lot is sized off `initialBalance` (or maxDeposit if set)
  //   100% → full compounding: lot is sized off current `portfolioEquityNow`
  //   x%   → partial compounding: base = initialBalance + pnl × (x/100)
  // Previously this code unconditionally used `portfolioEquityNow` as base AND
  // multiplied by `1 + reinvest/100` on top — so reinvest_percent had no effect
  // when 0 (already compounded) and double-inflated lots when >0 (compound + bonus).
  // Result: every backtest showed compounded growth regardless of the setting.
  const reinvestShare = strategy.fixed_lot
    ? 0
    : clampReinvestShare(
        ctx.reinvestPercentOverride >= 0
          ? ctx.reinvestPercentOverride
          : asNumber(strategy.reinvest_percent, 0),
      );
  const equityBaseRaw = strategy.fixed_lot
    ? (maxDeposit > 0 ? maxDeposit : ctx.initialBalance)
    : ctx.initialBalance + Math.max(0, portfolioEquityNow - ctx.initialBalance) * reinvestShare;
  const baseCapital = maxDeposit > 0
    ? Math.min(equityBaseRaw, maxDeposit)
    : equityBaseRaw;

  // Notional = capital × lot_fraction, capped by free margin passed in as portfolioEquityNow.
  let notional = baseCapital * lotFraction;
  if (Number.isFinite(portfolioEquityNow) && portfolioEquityNow > 0) {
    notional = Math.min(notional, portfolioEquityNow);
  }
  if (!Number.isFinite(notional) || notional <= 0) {
    return false;
  }

  const entryPrice = executionPrice(marketPrice, signal, 'entry', effectiveSlippageRate(ctx, strategy));
  const entryFee = notional * effectiveCommissionRate(ctx, strategy);

  ctx.cashEquity -= entryFee;

  runtime.state = signal;
  runtime.entryPrice = entryPrice;
  runtime.tpAnchorPrice = marketPrice;
  runtime.notional = notional;
  runtime.partialTpTriggered = false;
  runtime.openTrade = {
    side: signal,
    entryTime: eventTime,
    entryPrice,
    notional,
    entryFee,
    funding: 0,
  };

  ctx.lockedMargin += notional;

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
  if (normalized === 'stat_arb_zscore' || normalized === 'zz_breakout' || normalized === 'hideep') {
    return normalized;
  }
  return 'DD_BattleToads';
};

const normalizeMarketMode = (value: any): MarketMode => {
  return String(value || '').trim() === 'mono' ? 'mono' : 'synthetic';
};

/**
 * Deterministic PRNG (mulberry32). Same seed → identical sequence.
 * Used to break ties between strategies firing on the same bar so that
 * the pair-lock winner is fair across the whole backtest, not always
 * `strategyIndex === 0`.
 */
const createSeededRng = (seed: number): (() => number) => {
  let state = seed >>> 0;
  if (state === 0) state = 1;
  return () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

/**
 * Pair key matching runtime `getStrategyPairKey` in bot/strategy.ts.
 * Two strategies sharing the same key cannot be open simultaneously
 * (one position per pair at a time, even if OP allows more total positions).
 * NOTE: mono `BTCUSDT` and synthetic `BTCUSDT/ETHUSDT` produce DIFFERENT keys
 * — same as runtime, mono and synth on overlapping base symbols are NOT mutually locked.
 */
const getBacktestPairKey = (strategy: { market_mode?: any; base_symbol?: any; quote_symbol?: any }): string => {
  const mode = normalizeMarketMode(strategy.market_mode);
  const base = String(strategy.base_symbol || '').trim().toUpperCase();
  if (!base) return '';
  if (mode === 'mono') return `mono:${base}`;
  const quote = String(strategy.quote_symbol || '').trim().toUpperCase();
  if (!quote) return '';
  return `synthetic:${base}/${quote}`;
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

const SYNTHETIC_CANDLE_CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour
const SYNTHETIC_CANDLE_CACHE_MAX_ENTRIES = 200;

type SyntheticCandleCacheEntry = {
  candles: ParsedCandle[];
  timestamp: number;
};

const syntheticCandleCache = new Map<string, SyntheticCandleCacheEntry>();

const pruneSyntheticCandleCache = (): void => {
  const now = Date.now();
  for (const [key, entry] of syntheticCandleCache.entries()) {
    if (now - entry.timestamp > SYNTHETIC_CANDLE_CACHE_TTL_MS) {
      syntheticCandleCache.delete(key);
    }
  }

  if (syntheticCandleCache.size <= SYNTHETIC_CANDLE_CACHE_MAX_ENTRIES) {
    return;
  }

  const sortedByAge = Array.from(syntheticCandleCache.entries())
    .sort((left, right) => left[1].timestamp - right[1].timestamp);
  const excess = syntheticCandleCache.size - SYNTHETIC_CANDLE_CACHE_MAX_ENTRIES;
  for (let i = 0; i < excess; i += 1) {
    syntheticCandleCache.delete(sortedByAge[i][0]);
  }
};

const buildEvents = (
  runtimes: RuntimeStrategy[],
  options?: { tieBreakRng?: () => number },
): StrategyEvent[] => {
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

  if (options?.tieBreakRng) {
    // Stable randomized tie-break: assign each event a deterministic-random key,
    // then sort by (timeMs, randomKey). This prevents "strategyIndex 0 always
    // enters first" bias on bars where multiple strategies share a pair.
    const rng = options.tieBreakRng;
    const keyed = events.map((event) => ({ event, key: rng() }));
    keyed.sort((left, right) => {
      if (left.event.timeMs === right.event.timeMs) {
        return left.key - right.key;
      }
      return left.event.timeMs - right.event.timeMs;
    });
    return keyed.map((entry) => entry.event);
  }

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
    const strategyTypeForLength = normalizeStrategyType(strategy.strategy_type);
    // HiDeep needs mac1 + sma1Period(100) bars minimum — so effective warmup length is mac1+105
    const effectiveLength = strategyTypeForLength === 'hideep' ? Math.max(length + 105, 115) : length;
    const interval = String(strategy.interval || '1h');
    const intervalMs = intervalToMs(interval);
    const warmupBars = Math.max(0, Math.floor(request.warmupBars));

    const rangeBars = request.dateFromMs !== null && request.dateToMs !== null
      ? Math.max(1, Math.ceil((request.dateToMs - request.dateFromMs) / Math.max(intervalMs, 1)) + 1)
      : request.bars;

    const candlesLimit = Math.max(effectiveLength + warmupBars + 40, rangeBars + warmupBars + 20, request.bars);
    const fetchStartMs = request.dateFromMs !== null
      ? Math.max(0, request.dateFromMs - (warmupBars + effectiveLength) * intervalMs)
      : null;
    const fetchEndMs = request.dateToMs;

    const cacheKey = [
      // Cache by EXCHANGE rather than apiKeyName so different keys on the same
      // exchange (e.g. BTDD_D1 + BTDD_D1_OP both Bybit) share fetched candles
      // — major speed-up for multi-key sweep fan-out and for sweep restarts
      // where the same data was already fetched in a previous run.
      getExchangeForApiKey(request.dataApiKeyName) || `key:${request.dataApiKeyName}`,
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

    let cacheEntry = syntheticCandleCache.get(cacheKey);
    if (cacheEntry && Date.now() - cacheEntry.timestamp >= SYNTHETIC_CANDLE_CACHE_TTL_MS) {
      syntheticCandleCache.delete(cacheKey);
      cacheEntry = undefined;
    }
    let candles = cacheEntry?.candles;
    const marketMode = normalizeMarketMode(strategy.market_mode);

    if (!candles) {
      // Try with the original [fetchStartMs..fetchEndMs] window first; if that
      // returns nothing or too few candles AND a startMs was specified (typical
      // for new listings whose history is shorter than the requested window),
      // retry once without startMs so we get whatever the exchange has.
      const fetchOnce = async (overrideStartMs: number | null): Promise<unknown> => {
        const opts = {
          startMs: overrideStartMs === null ? undefined : overrideStartMs,
          endMs: fetchEndMs === null ? undefined : fetchEndMs,
        };
        return marketMode === 'mono'
          ? await getMarketData(
            request.dataApiKeyName,
            strategy.base_symbol,
            interval,
            candlesLimit,
            opts
          )
          : await calculateSyntheticOHLC(
            request.dataApiKeyName,
            strategy.base_symbol,
            strategy.quote_symbol,
            asNumber(strategy.base_coef, 1),
            asNumber(strategy.quote_coef, 1),
            interval,
            candlesLimit,
            opts
          );
      };

      let raw: unknown;
      let firstError: Error | null = null;
      try {
        raw = await fetchOnce(fetchStartMs);
      } catch (fetchError) {
        firstError = fetchError as Error;
        raw = [];
      }

      let parsed = (Array.isArray(raw) ? raw : [])
        .map((item) => parseCandle(item))
        .filter((item): item is ParsedCandle => !!item)
        .sort((a, b) => a.timeMs - b.timeMs);

      // Fallback: short-history pair — drop startMs and take whatever exists.
      if (parsed.length <= length && fetchStartMs !== null) {
        try {
          const rawNoStart = await fetchOnce(null);
          const parsedNoStart = (Array.isArray(rawNoStart) ? rawNoStart : [])
            .map((item) => parseCandle(item))
            .filter((item): item is ParsedCandle => !!item)
            .sort((a, b) => a.timeMs - b.timeMs);
          if (parsedNoStart.length > parsed.length) {
            parsed = parsedNoStart;
            firstError = null;
          }
        } catch (fallbackError) {
          if (!firstError) firstError = fallbackError as Error;
        }
      }

      if (parsed.length === 0 && firstError) {
        const reason = firstError.message || 'candle fetch error';
        if (request.skipMissingSymbols) {
          skipped.push({ strategyId: Number(strategy.id), strategyName: strategy.name, reason });
          continue;
        }
        throw firstError;
      }

      candles = parsed;
      syntheticCandleCache.set(cacheKey, { candles, timestamp: Date.now() });
      pruneSyntheticCandleCache();
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
      const idx = candles.findIndex((item) => item.timeMs >= dateFromMs);
      // Fallback for short-history pairs: if no candle is at-or-after dateFrom,
      // OR the entire history starts later than dateFrom, just use whatever
      // is available (record actualDataStartMs in summary so callers know).
      firstInRangeIndex = idx < 0 ? 0 : idx;
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

    const startIndex = Math.max(effectiveLength, firstInRangeIndex + warmupBars);
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
      partialTpTriggered: false,
        dcaState: extractDcaConfigFromStrategy(strategy),
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
  const commissionPercent = clamp(asNumber(raw.commissionPercent, 0.1), 0, 5);
  const slippagePercent = clamp(asNumber(raw.slippagePercent, 0.05), 0, 5);
  const fundingRatePercent = clamp(asNumber(raw.fundingRatePercent, 0), -5, 5);
  const maxOpenPositions = Math.max(0, Math.floor(asNumber(raw.maxOpenPositions, 0)));
  const partialTpPct = Math.max(0, asNumber(raw.partialTpPct, 0));
  const dateFromMs = parseTimestampMs(raw.dateFrom);
  const dateToMs = parseDateToMs(raw.dateTo);

  if (dateFromMs !== null && dateToMs !== null && dateToMs <= dateFromMs) {
    throw new Error('dateTo must be later than dateFrom');
  }

  const apiKeyNameNorm = String(raw.apiKeyName || '').trim();
  const dataApiKeyNameRaw = String(raw.dataApiKeyName || '').trim();
  return {
    apiKeyName: apiKeyNameNorm,
    dataApiKeyName: dataApiKeyNameRaw || apiKeyNameNorm,
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
    maxOpenPositions,
    maxDepositOverride: Math.max(0, asNumber(raw.maxDepositOverride, 0)),
    lotPercentOverride: Math.max(0, asNumber(raw.lotPercentOverride, 0)),
    lotPercentMultiplierByStrategyId: (() => {
      const map = new Map<number, number>();
      const src = (raw as { lotPercentMultiplierByStrategyId?: Record<string | number, unknown> })?.lotPercentMultiplierByStrategyId;
      if (src && typeof src === 'object') {
        for (const [key, value] of Object.entries(src)) {
          const sid = Number(key);
          const mul = Number(value);
          if (Number.isFinite(sid) && sid > 0 && Number.isFinite(mul)) {
            map.set(sid, Math.max(0, Math.min(10, mul)));
          }
        }
      }
      return map;
    })(),
    reinvestPercentOverride: (() => {
      const v = (raw as { reinvestPercentOverride?: unknown })?.reinvestPercentOverride;
      if (v === undefined || v === null || v === '') return -1;
      const n = Number(v);
      return Number.isFinite(n) && n >= 0 ? Math.min(100, n) : -1;
    })(),
    partialTpPct,
    autoLotByChannelWidth: raw.autoLotByChannelWidth === true,
    enablePairLock: (raw as unknown as { enablePairLock?: boolean })?.enablePairLock !== false,
    pairLockSeed: Math.max(
      1,
      Math.floor(asNumber((raw as unknown as { pairLockSeed?: number })?.pairLockSeed, 1759827600)),
    ),
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

  const events = buildEvents(
    runtimes,
    request.enablePairLock
      ? { tieBreakRng: createSeededRng(request.pairLockSeed) }
      : undefined,
  );

  if (events.length === 0) {
    throw new Error('No strategy events available for backtest');
  }

  const ctx: BacktestContext = {
    cashEquity: request.initialBalance,
    lockedMargin: 0,
    commissionRate: request.commissionPercent / 100,
    slippageRate: request.slippagePercent / 100,
    fundingRate: request.fundingRatePercent / 100,
    trades: [],
    maxDepositOverride: request.maxDepositOverride,
    lotPercentOverride: request.lotPercentOverride,
    lotPercentMultiplierByStrategyId: request.lotPercentMultiplierByStrategyId,
    reinvestPercentOverride: request.reinvestPercentOverride,
    initialBalance: request.initialBalance,
    autoLotByChannelWidth: request.autoLotByChannelWidth,
  };

  const maxOpenPositions = request.maxOpenPositions;
  const partialTpPct = request.partialTpPct;
  let skippedByPositionLimit = 0;
  let skippedByPairLock = 0;

  // Precompute pair keys per runtime so we can do O(N) pair-lock check per signal.
  // Mirrors runtime `getStrategyPairKey` in bot/strategy.ts so backtest matches live behavior.
  const pairKeyByRuntimeIndex: string[] = runtimes.map((rt) => getBacktestPairKey(rt.strategy));

  /** Classic DCA grids use fixed base USDT sizing — they do not consume TS max-open-position slots. */
  const countsTowardOpLimit = (rt: RuntimeStrategy): boolean => !rt.dcaState?.enabled;

  const countOpenPositions = (): number => {
    return runtimes.filter((rt) => rt.state !== 'flat' && countsTowardOpLimit(rt)).length;
  };

  const isPairLocked = (selfIndex: number, pairKey: string): boolean => {
    if (!pairKey) return false;
    for (let i = 0; i < runtimes.length; i++) {
      if (i === selfIndex) continue;
      if (runtimes[i].state === 'flat') continue;
      if (pairKeyByRuntimeIndex[i] === pairKey) return true;
    }
    return false;
  };

  const equityCurve: BacktestPoint[] = [];
  let peak = request.initialBalance;
  let maxDrawdownAbsolute = 0;
  let maxDrawdownPercent = 0;

  const pushEquityPoint = (timeMs: number) => {
    const value = Math.max(0, portfolioEquity(ctx.cashEquity, runtimes));
    equityCurve.push({
      time: Math.floor(timeMs / 1000),
      equity: value,
    });

    peak = Math.max(peak, value);
    const drawdownAbs = peak - value;
    const drawdownPct = peak > 0 ? Math.min(100, (drawdownAbs / peak) * 100) : 0;

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
    const isClassicDca = Boolean(runtime.dcaState?.enabled);
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

    // DCA TP / per-leg SL / aggregate SL
    if (runtime.dcaState && runtime.state !== 'flat' && runtime.entryPrice && runtime.notional > 0) {
      const dc = runtime.dcaState;
      if (dc.perLegSl && dc.slPercent > 0 && dc.legs.length > 0) {
        let legClosed = false;
        for (let legIndex = 0; legIndex < dc.legs.length; ) {
          const leg = dc.legs[legIndex];
          const legSlPrice = leg.price * (1 - dc.slPercent / 100);
          if (candle.close <= legSlPrice) {
            closeDcaLeg(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, candle.close, leg, 'dca_leg_sl');
            dc.legs.splice(legIndex, 1);
            legClosed = true;
          } else {
            legIndex += 1;
          }
        }
        if (legClosed) {
          if (dc.legs.length === 0) {
            runtime.state = 'flat';
            runtime.entryPrice = null;
            runtime.tpAnchorPrice = null;
            runtime.notional = 0;
            runtime.openTrade = null;
            runtime.partialTpTriggered = false;
            dc.ordersCount = 0;
            dc.totalInvested = 0;
            dc.totalQty = 0;
            dc.lastBuyPrice = 0;
            dc.barsSinceFlat = 0;
            closedOnCurrentBar = true;
          } else {
            syncDcaRuntimeFromLegs(ctx, runtime, dc);
          }
        }
      }
      if (!closedOnCurrentBar && dc.totalQty > 0 && dc.totalInvested > 0) {
        const avgBuy = dc.totalInvested / dc.totalQty;
        const tpPrice = avgBuy * (1 + dc.tpPercent / 100);
        const slPrice = !dc.perLegSl && dc.slPercent > 0 ? avgBuy * (1 - dc.slPercent / 100) : 0;
        if (candle.close >= tpPrice) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, candle.close, 'dca_tp');
          runtime.dcaState.ordersCount = 0;
          runtime.dcaState.totalInvested = 0;
          runtime.dcaState.totalQty = 0;
          runtime.dcaState.lastBuyPrice = 0;
          runtime.dcaState.legs = [];
          runtime.dcaState.barsSinceFlat = 0;
          closedOnCurrentBar = true;
        } else if (slPrice > 0 && candle.close <= slPrice) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, candle.close, 'dca_sl');
          runtime.dcaState.ordersCount = 0;
          runtime.dcaState.totalInvested = 0;
          runtime.dcaState.totalQty = 0;
          runtime.dcaState.lastBuyPrice = 0;
          runtime.dcaState.legs = [];
          runtime.dcaState.barsSinceFlat = 0;
          closedOnCurrentBar = true;
        }
      }
    }

    // Partial TP: applies to non-DCA strategy types
    if (!isClassicDca && !closedOnCurrentBar && !runtime.partialTpTriggered && partialTpPct > 0 && (state === 'long' || state === 'short') && entryPrice && entryPrice > 0) {
      const currentPnlPct = state === 'long'
        ? ((signalPayload.current / entryPrice) - 1) * 100
        : ((entryPrice / signalPayload.current) - 1) * 100;

      if (currentPnlPct >= partialTpPct) {
        partialClosePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'partial_tp_50pct', 0.5);
        runtime.partialTpTriggered = true;
        // Move TP anchor to entry price (break-even) so trailing stop runs from there
        if (state === 'long') {
          runtime.tpAnchorPrice = Math.max(entryPrice, signalPayload.current);
        } else {
          runtime.tpAnchorPrice = Math.min(entryPrice, signalPayload.current);
        }
      }
    }

    if (!isClassicDca && isStatArb) {
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
    } else if (!isClassicDca) {
      // HiDeep RSI-based exit: fastRSI (stored in zScore) crosses overbought/oversold
      if (strategyType === 'hideep' && Number.isFinite(signalPayload.zScore)) {
        const fastRsi = Number(signalPayload.zScore);
        if (!closedOnCurrentBar && state === 'long' && fastRsi > 90) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'hideep_rsi_exit_long');
          closedOnCurrentBar = true;
        }
        if (!closedOnCurrentBar && state === 'short' && fastRsi < 10) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'hideep_rsi_exit_short');
          closedOnCurrentBar = true;
        }
      }

      if (!closedOnCurrentBar && state === 'long' && takeProfitPercent > 0) {
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


    // DCA safety order
    if (!closedOnCurrentBar && runtime.dcaState && runtime.state !== 'flat' &&
        runtime.dcaState.lastBuyPrice > 0 && runtime.dcaState.ordersCount < runtime.dcaState.maxOrders) {
      const dc = runtime.dcaState;
      const stepTrigger = dc.lastBuyPrice * (1 - dc.stepPercent / 100);
      if (candle.close <= stepTrigger) {
        const safetySize = dc.baseAmountUsdt * Math.pow(dc.orderMultiplier, dc.ordersCount);
        const safetyQty = safetySize / candle.close;
        const entryFee = safetySize * effectiveCommissionRate(ctx, runtime.strategy);
        ctx.cashEquity -= entryFee;
        ctx.lockedMargin += safetySize;
        runtime.openTrade!.entryFee += entryFee;
        dc.legs.push({ price: candle.close, qty: safetyQty, invested: safetySize, isBase: false });
        syncDcaRuntimeFromLegs(ctx, runtime, dc);
      }
    }

    // Classic DCA: long-only grid entry on bar close; no Donchian signals
    if (isClassicDca) {
      if (runtime.state === 'flat' && runtime.dcaState) {
        runtime.dcaState.barsSinceFlat += 1;
        if (!closedOnCurrentBar && passesClassicDcaEntryFilter(runtime.dcaState, runtime.candles, event.candleIndex)) {
          // DCA does not participate in TS OP limit (only non-overlap with TS markets at pick/apply time).
          if (request.enablePairLock) {
            const pairKey = pairKeyByRuntimeIndex[event.strategyIndex];
            if (isPairLocked(event.strategyIndex, pairKey)) {
              skippedByPairLock++;
            } else {
              const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
              const availableBalance = Math.max(0, equityNow - computeLockedMargin(runtimes));
              openPosition(ctx, runtime, 'long', event.timeMs, candle.close, availableBalance);
            }
          } else {
            const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
            const availableBalance = Math.max(0, equityNow - computeLockedMargin(runtimes));
            openPosition(ctx, runtime, 'long', event.timeMs, candle.close, availableBalance);
          }
        }
      }
      pushEquityPoint(event.timeMs);
      continue;
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

    if (closedOnCurrentBar && runtime.state === 'flat') {
      pushEquityPoint(event.timeMs);
      continue;
    }

    // Position Limiter (ОП): skip entry if max open positions reached
    if (runtime.state === 'flat' && maxOpenPositions > 0 && countOpenPositions() >= maxOpenPositions) {
      skippedByPositionLimit++;
      pushEquityPoint(event.timeMs);
      continue;
    }

    // Pair-lock (mirrors runtime) — OPT-IN: skip entry if another strategy holds the same pair.
    // Выключено по умолчанию (request.enablePairLock=false). Портфельные бэктесты с сотнями
    // стратегий на пересекающихся парах могут резко менять результат из-за эффекта first-wins при
    // детерминированном порядке событий (в рантайме блокировка по API ключу и асинхронная).
    if (request.enablePairLock && runtime.state === 'flat') {
      const pairKey = pairKeyByRuntimeIndex[event.strategyIndex];
      if (isPairLocked(event.strategyIndex, pairKey)) {
        skippedByPairLock++;
        pushEquityPoint(event.timeMs);
        continue;
      }
    }

    const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
    const availableBalance = Math.max(0, equityNow - computeLockedMargin(runtimes));
    const lotChannelMult = resolveAutoLotChannelWidthMult(runtime, event.candleIndex, strategy, ctx, signalPayload);
    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, availableBalance, lotChannelMult);
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

  let actualDataStartMs: number | null = null;
  let actualDataEndMs: number | null = null;
  for (const rt of runtimes) {
    if (!rt.candles || rt.candles.length === 0) continue;
    const first = rt.candles[Math.max(0, rt.startIndex)]?.timeMs;
    const last = rt.candles[Math.min(rt.candles.length - 1, rt.endIndex)]?.timeMs;
    if (Number.isFinite(first)) {
      actualDataStartMs = actualDataStartMs === null ? first : Math.min(actualDataStartMs, first);
    }
    if (Number.isFinite(last)) {
      actualDataEndMs = actualDataEndMs === null ? last : Math.max(actualDataEndMs, last);
    }
  }

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
    maxOpenPositions: request.maxOpenPositions,
    skippedByPositionLimit,
    skippedByPairLock,
    actualDataStartMs,
    actualDataEndMs,
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
    maxOpenPositions: request.maxOpenPositions,
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
    maxOpenPositions: 0,
    skippedByPositionLimit: 0,
    skippedByPairLock: 0,
    actualDataStartMs: null,
    actualDataEndMs: null,
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

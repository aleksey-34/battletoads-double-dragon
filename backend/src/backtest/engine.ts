import { MarketMode, Strategy, StrategyType } from '../config/settings';
import { getStrategies } from '../bot/strategy';
import { getMarketData, getExchangeForApiKey } from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { db } from '../utils/database';
import fs from 'fs';
import path from 'path';
import logger from '../utils/logger';
import { computeChannelWidthLotMultiplier } from '../services/strategy/sizing';
import { resolveBacktestRangeIndices } from './backtestWarmupRange';
import {
  PortfolioCircuitBreakerConfig,
  PortfolioCircuitBreakerTracker,
  parsePortfolioCircuitBreaker,
} from '../services/portfolioCircuitBreaker';
import {
  FatTailSyncConfig,
  FatTailSyncTracker,
  parseFatTailSync,
} from '../services/fatTailSyncCooldown';
import {
  ResearchLotScheduleConfig,
  ResearchLotScheduleTracker,
  parseResearchLotSchedule,
} from '../services/researchLotSchedule';
import {
  normalizeOrderBlockEntryGate,
  passesOrderBlockEntryGate,
  type OrderBlockEntryGate,
} from '../bot/orderBlockLiquidity';
import {
  buildZzPivotLevelSeries,
  computeZzPivotEntrySignal,
  isZzPivotStrategyType,
  normalizeZzPivotStrategyType,
  zzPivotVariantFromType,
  type ZzPivotLevels,
} from '../bot/zzPivotLevels';
import {
  computeCtFractalSignalAtIndex,
  isCtFractalStrategyType,
} from '../bot/ctFractalSignal';
import {
  buildMomentumScalpIndicatorSeries,
  computeMomentumScalpSignalAtIndex,
  extractMomentumScalpParams,
  isMomentumScalpStrategyType,
  momentumScalpTpSlPrices,
  type MomentumScalpIndicatorSeries,
} from '../bot/momentumScalpSignal';
import {
  evaluateMrs2Bar,
  extractMrs2Params,
  isMrs2StrategyType,
  mrs2WarmupBars,
  type Mrs2Params,
  type Mrs2PendingLimits,
} from '../bot/mrs2Signal';
import { readHybridCandles } from '../bot/hybridCandleStore';

export type { OrderBlockEntryGate };

export type BacktestMode = 'single' | 'portfolio';

/** Recipe book lots are 8–18%; admin shared-margin uses override=1 × lot. */
export const LOT_PERCENT_MULTIPLIER_MAX = 500;

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
  cashEquity?: number;
  unrealizedPnl?: number;
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
  skippedStrategyDetails?: Array<{ strategyId: number; strategyName: string; reason: string }>;
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
  skippedByOrderBlockGate: number;
  /** CB triggers fired during backtest (0 when disabled). */
  portfolioCircuitBreakerTriggers?: number;
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
  /**
   * Per-book OP for multi-TS portfolio reruns (shared margin / one event stream).
   * bookKey → max concurrent open positions among strategies tagged with that book.
   * When set, each book is limited independently; global maxOpenPositions (if >0) still applies as a hard cap.
   */
  maxOpenPositionsByBook?: Record<string, number>;
  /** strategyId → bookKey (role) for maxOpenPositionsByBook accounting. */
  bookKeyByStrategyId?: Record<string | number, string>;
  /**
   * When true (default), same-symbol opposite-side entries are pair-locked in portfolio mode.
   * Passed through from admin preview; also accepted via cast for older callers.
   */
  enablePairLock?: boolean;
  /** Seed for pair-lock tie-break RNG. */
  pairLockSeed?: number;
  /** Override max_deposit on all strategies (scales position sizing to match initialBalance). */
  maxDepositOverride?: number;
  /** Override lot_long_percent / lot_short_percent on all strategies. */
  lotPercentOverride?: number;
  /**
   * Per-strategy multiplier applied to lot_long_percent / lot_short_percent
   * (or to lotPercentOverride when set). Used by trading-system backtests to
   * apply per-member weights from the storefront card. Missing entries default
   * to 1.0 (no change). Values are clamped to [0, LOT_PERCENT_MULTIPLIER_MAX] so recipe book lots (12/15/16) survive override=1 × lot.
   */
  lotPercentMultiplierByStrategyId?: Record<string | number, number>;
  /** Override reinvest_percent on all strategies (0..100). Use -1 / undefined to keep per-strategy DB value. */
  reinvestPercentOverride?: number;
  /**
   * Per-strategy reinvest % (0..100). Used by shared-margin portfolio BT so each book
   * keeps its own ri instead of forcing Math.max across books. Ignored when
   * reinvestPercentOverride >= 0.
   */
  reinvestPercentByStrategyId?: Record<string | number, number>;
  /**
   * Partial take-profit: when a position reaches this PnL% threshold, close 50%
   * at market and set break-even anchor on the remainder (0 = disabled).
   */
  partialTpPct?: number;
  /** RSI / anchor-based early exit overlay (research + TS preview). */
  macroExitOverlay?: MacroExitOverlay;
  /** Fractal/RSI entry gate for stat_arb_zscore strategies only. */
  statArbEntryGate?: StatArbEntryGate;
  /** BTC liquidity / order-block fade gate for all TS entries. */
  orderBlockEntryGate?: import('../bot/orderBlockLiquidity').OrderBlockEntryGate;
  /** When true, scale trend lot by inverse Donchian channel width at entry. */
  autoLotByChannelWidth?: boolean;
  /** Portfolio DD circuit breaker — scales new entry lot during drawdown cooldown. */
  portfolioCircuitBreaker?: PortfolioCircuitBreakerConfig;
  /** After sync loss day, temporarily cut lot on selected breakout legs. */
  fatTailSyncCooldown?: FatTailSyncConfig;
  /**
   * Research-only: scale new entry lots on precomputed UTC days
   * (e.g. lag-1 boost after BTC/SPX dump / VIX spike).
   */
  researchLotSchedule?: ResearchLotScheduleConfig;
  /**
   * Research: for Donchian/zz_breakout, replace center-stop with
   * entry ± fraction*(donchianHigh-donchianLow). 0/undefined = classic center stop.
   */
  channelWidthStopFraction?: number;
};

export type MacroExitRule = {
  /** self = strategy symbol; anchor = BTCUSDT / ETHUSDT / SOLUSDT etc. */
  source: 'self' | 'anchor';
  anchorSymbol?: string;
  rsiPeriod?: number;
  /** Close long when RSI >= threshold (take profit / overbought). */
  longExitRsiAbove?: number;
  /** Close long when RSI <= threshold (reversal / risk-off). */
  longExitRsiBelow?: number;
  /** Close short when RSI <= threshold. */
  shortExitRsiBelow?: number;
  /** Close short when RSI >= threshold. */
  shortExitRsiAbove?: number;
  /** Exit long on confirmed bearish (swing-high) Williams fractal. */
  longExitBearishFractal?: boolean;
  /** Exit short on confirmed bullish (swing-low) Williams fractal. */
  shortExitBullishFractal?: boolean;
  /** Fractal wing bars each side (default 2 = classic 5-bar fractal). */
  fractalWings?: number;
  /** When RSI + fractal both set: require both ('and') or either ('or'). Default 'and'. */
  combineWith?: 'and' | 'or';
  mode?: 'full' | 'partial';
  /** Fraction to close when mode=partial (default 0.5). */
  closeFraction?: number;
  label?: string;
};

export type MacroExitVoteConfig = {
  /** Minimum anchor votes required (e.g. 2 of BTC/ETH/SOL). */
  minVotes: number;
  anchors: string[];
  rsiPeriod?: number;
  fractalWings?: number;
  longExitRsiAbove?: number;
  longExitBearishFractal?: boolean;
  shortExitRsiBelow?: number;
  shortExitRsiAbove?: number;
  shortExitBullishFractal?: boolean;
  mode?: 'full' | 'partial';
  closeFraction?: number;
  label?: string;
};

export type MacroExitOverlay = {
  rules: MacroExitRule[];
  /** Interval for anchor symbol candles (defaults to first strategy interval). */
  anchorInterval?: string;
  /** Global multi-anchor vote (e.g. 2/3 BTC+ETH+SOL overheat → full exit). */
  globalVote?: MacroExitVoteConfig;
  /** Pair-local exit on the strategy's own symbol (typically partial). */
  localSelf?: MacroExitRule;
};

/** Gate stat_arb_zscore entries with fractal / RSI confirmation on self or anchor. */
export type StatArbEntryGate = {
  /** Candle interval for gate signals (defaults to strategy interval). */
  gateInterval?: string;
  /** Use anchor symbol candles instead of the strategy's market. */
  anchorSymbol?: string;
  fractalWings?: number;
  /** How many gate-TF bars back to search for a confirmed fractal. */
  lookbackBars?: number;
  /** Long entry requires recent bullish (swing-low) fractal. */
  longRequireBullishFractal?: boolean;
  /** Short entry requires recent bearish (swing-high) fractal. */
  shortRequireBearishFractal?: boolean;
  rsiPeriod?: number;
  /** Long entry when gate RSI <= threshold (oversold). */
  longRsiBelow?: number;
  /** Short entry when gate RSI >= threshold (overbought). */
  shortRsiAbove?: number;
  combineWith?: 'and' | 'or';
  label?: string;
};

export const DEFAULT_STAT_ARB_ENTRY_GATE: StatArbEntryGate = {
  gateInterval: '4h',
  fractalWings: 2,
  lookbackBars: 12,
  longRequireBullishFractal: true,
  shortRequireBearishFractal: true,
  label: 'self_frac4h_lb12',
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
  maxOpenPositionsByBook: Map<string, number>;
  bookKeyByStrategyId: Map<number, string>;
  maxDepositOverride: number;
  lotPercentOverride: number;
  lotPercentMultiplierByStrategyId: Map<number, number>;
  reinvestPercentOverride: number;
  reinvestPercentByStrategyId: Map<number, number>;
  partialTpPct: number;
  macroExitOverlay: MacroExitOverlay | null;
  statArbEntryGate: StatArbEntryGate | null;
  orderBlockEntryGate: OrderBlockEntryGate | null;
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
  portfolioCircuitBreaker: PortfolioCircuitBreakerConfig | null;
  fatTailSyncCooldown: FatTailSyncConfig | null;
  researchLotSchedule: ResearchLotScheduleConfig | null;
  channelWidthStopFraction: number;
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

/** Global override wins; else per-strategy map; else strategy.reinvest_percent from DB. */
const resolveReinvestShare = (
  ctx: Pick<BacktestContext, 'reinvestPercentOverride' | 'reinvestPercentByStrategyId'>,
  strategy: { id?: number | string; reinvest_percent?: number; fixed_lot?: number | boolean },
): number => {
  if (strategy.fixed_lot) return 0;
  if (ctx.reinvestPercentOverride >= 0) {
    return clampReinvestShare(ctx.reinvestPercentOverride);
  }
  const sid = Number(strategy.id);
  if (Number.isFinite(sid) && ctx.reinvestPercentByStrategyId.has(sid)) {
    return clampReinvestShare(ctx.reinvestPercentByStrategyId.get(sid) as number);
  }
  return clampReinvestShare(asNumber(strategy.reinvest_percent, 0));
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

/**
 * How a MeanReversion/MRS2 limit entry and its close-MA exit are allowed to book
 * inside the same bar.
 *
 * Default is `block` (live-closer): live never entry→exit in one cycle.
 * Legacy optimistic OHLC (`allow`) must be opted in via env — that mode assumed
 * entry-first ordering OHLC cannot confirm and inflated July/Aug research stamps.
 *
 * `MRS2_BT_SAME_BAR_EXIT`:
 *   block        — never exit on the entry bar (default; position is carried)
 *   allow        — legacy optimistic behaviour (research only)
 *   path         — consult finer sub-bars (`MRS2_BT_SUBBAR_INTERVAL`) and only
 *                  exit when a sub-bar touching the entry precedes one touching
 *                  the exit; anything unresolvable is carried (lower bound)
 *   path_lenient — same, but ordering that is ambiguous inside a single sub-bar
 *                  or lacks sub-bars altogether is resolved in the trade's
 *                  favour (upper bound)
 */
type Mrs2SameBarExitMode = 'allow' | 'block' | 'path' | 'path_lenient';

const resolveMrs2SameBarExitMode = (): Mrs2SameBarExitMode => {
  const raw = String(process.env.MRS2_BT_SAME_BAR_EXIT || '').trim().toLowerCase();
  if (raw === 'allow' || raw === 'on' || raw === '1' || raw === 'true' || raw === 'legacy') return 'allow';
  if (raw === 'path') return 'path';
  if (raw === 'path_lenient' || raw === 'pathlenient') return 'path_lenient';
  // unset / block / off / false / 0 → block (live-parity default)
  return 'block';
};

type Mrs2SubBarIndex = {
  /** Sub-bars grouped by parent-bar bucket start (epoch-aligned). */
  byBucket: Map<number, ParsedCandle[]>;
  parentMs: number;
  /** Sub-bars a complete parent bar must contain for the path to be trusted. */
  expectedPerBucket: number;
};

const loadMrs2SubBarIndex = (
  symbol: string,
  parentInterval: string,
): Mrs2SubBarIndex | undefined => {
  const subInterval = String(process.env.MRS2_BT_SUBBAR_INTERVAL || '').trim();
  if (!subInterval) return undefined;
  const parentMs = intervalToMs(parentInterval);
  const subMs = intervalToMs(subInterval);
  if (!(parentMs > 0) || !(subMs > 0) || subMs >= parentMs) return undefined;
  const rows = readHybridCandles(symbol, subInterval);
  if (!rows || rows.length === 0) return undefined;
  const byBucket = new Map<number, ParsedCandle[]>();
  for (const row of rows) {
    const candle = parseCandle(row);
    if (!candle) continue;
    const bucket = Math.floor(candle.timeMs / parentMs) * parentMs;
    const list = byBucket.get(bucket);
    if (list) list.push(candle);
    else byBucket.set(bucket, [candle]);
  }
  for (const list of byBucket.values()) list.sort((a, b) => a.timeMs - b.timeMs);
  return { byBucket, parentMs, expectedPerBucket: Math.round(parentMs / subMs) };
};

/**
 * Did the sub-bar path put the entry fill before the exit limit became
 * reachable? `lenient` decides the ambiguous cases — missing/partial sub-bars
 * and both levels inside one sub-bar — in the trade's favour, which brackets
 * the strict answer from above. Exit-reached-first is always a rejection.
 */
const mrs2SameBarExitConfirmed = (
  index: Mrs2SubBarIndex | undefined,
  parentTimeMs: number,
  side: 'long' | 'short',
  entryPrice: number,
  exitPrice: number,
  lenient: boolean,
): boolean => {
  if (!index) return lenient;
  const bucket = Math.floor(parentTimeMs / index.parentMs) * index.parentMs;
  const subBars = index.byBucket.get(bucket);
  if (!subBars || subBars.length < index.expectedPerBucket) return lenient;
  const exitReached = (candle: ParsedCandle): boolean => (
    side === 'long' ? candle.high >= exitPrice : candle.low <= exitPrice
  );
  for (let i = 0; i < subBars.length; i += 1) {
    const candle = subBars[i];
    const entryReached = candle.low <= entryPrice && entryPrice <= candle.high;
    if (entryReached && exitReached(candle)) return lenient;
    if (entryReached) {
      for (let j = i + 1; j < subBars.length; j += 1) {
        if (exitReached(subBars[j])) return true;
      }
      return false;
    }
    if (exitReached(candle)) return false;
  }
  return false;
};

type BacktestSignalPayload = {
  signal: Signal;
  current: number;
  donchianCenter: number;
  donchianHigh?: number;
  donchianLow?: number;
  fastRsi?: number | null;
  zScore: number | null;
  oppositeCross?: boolean;
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
      donchianHigh,
      donchianLow,
      zScore: null,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      current: current.close,
      donchianCenter,
      donchianHigh,
      donchianLow,
      zScore: null,
    };
  }

  return {
    signal: 'none',
    current: current.close,
    donchianCenter,
    donchianHigh,
    donchianLow,
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

const computeZzPivotSignalAtIndex = (
  candles: ParsedCandle[],
  index: number,
  zzPivotLevelSeries: ZzPivotLevels[] | undefined,
  longEnabled: boolean,
  shortEnabled: boolean,
): BacktestSignalPayload => {
  const levels = zzPivotLevelSeries?.[index];
  const current = candles[index];
  if (!levels || !current) {
    return { signal: 'none', current: current?.close ?? 0, donchianCenter: 0, zScore: null };
  }
  const entry = computeZzPivotEntrySignal(current, levels, longEnabled, shortEnabled);
  const center = (levels.levelLong + levels.levelShort) / 2;
  return {
    signal: entry,
    current: current.close,
    donchianCenter: center,
    donchianHigh: levels.levelLong,
    donchianLow: levels.levelShort,
    zScore: null,
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
  shortEnabled: boolean,
  zzPivotLevelSeries?: ZzPivotLevels[],
  msOptions?: {
    params?: ReturnType<typeof extractMomentumScalpParams>;
    series?: MomentumScalpIndicatorSeries;
    positionSide?: PositionState;
    zscoreExit?: number;
    zscoreStop?: number;
    takeProfitPercent?: number;
  },
): BacktestSignalPayload => {
  if (strategyType === 'stat_arb_zscore') {
    return computeStatArbSignalAtIndex(candles, index, length, zscoreEntry, longEnabled, shortEnabled);
  }

  if (strategyType === 'hideep') {
    return computeHiDeepSignalAtIndex(candles, index, length, zscoreEntry, longEnabled, shortEnabled);
  }

  const canonicalType = normalizeZzPivotStrategyType(strategyType) as StrategyType;
  if (isZzPivotStrategyType(canonicalType)) {
    return computeZzPivotSignalAtIndex(
      candles,
      index,
      zzPivotLevelSeries,
      longEnabled,
      shortEnabled,
    );
  }

  if (isCtFractalStrategyType(strategyType)) {
    const ct = computeCtFractalSignalAtIndex(
      candles,
      index,
      length,
      zscoreEntry,
      longEnabled,
      shortEnabled,
    );
    return {
      signal: ct.signal,
      current: ct.current,
      donchianCenter: ct.donchianCenter,
      zScore: ct.zScore,
      fastRsi: ct.fastRsi,
    };
  }

  if (isMomentumScalpStrategyType(strategyType)) {
    const params = msOptions?.params ?? extractMomentumScalpParams({
      price_channel_length: length,
      zscore_entry: zscoreEntry,
      zscore_exit: msOptions?.zscoreExit,
      zscore_stop: msOptions?.zscoreStop,
      take_profit_percent: msOptions?.takeProfitPercent,
      long_enabled: longEnabled,
      short_enabled: shortEnabled,
    } as Strategy);
    const ms = computeMomentumScalpSignalAtIndex(
      candles,
      index,
      params,
      msOptions?.series,
      msOptions?.positionSide ?? 'flat',
    );
    return {
      signal: ms.signal,
      current: ms.current,
      donchianCenter: ms.current,
      zScore: ms.adx,
      fastRsi: ms.plusDi,
      oppositeCross: ms.oppositeCross,
    };
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

const findCandleIndexAtOrBefore = (candles: ParsedCandle[], timeMs: number): number => {
  if (!candles.length) return 0;
  let lo = 0;
  let hi = candles.length - 1;
  let ans = 0;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (candles[mid].timeMs <= timeMs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
};

const isBearishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotHigh = candles[index].high;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].high >= pivotHigh) return false;
    if (candles[index + offset].high >= pivotHigh) return false;
  }
  return true;
};

const isBullishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotLow = candles[index].low;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].low <= pivotLow) return false;
    if (candles[index + offset].low <= pivotLow) return false;
  }
  return true;
};

const hasConfirmedBearishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBearishFractalAt(candles, pivotIndex, wings);
};

const hasConfirmedBullishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBullishFractalAt(candles, pivotIndex, wings);
};

const normalizeMacroExitOverlay = (raw: unknown): MacroExitOverlay | null => {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as MacroExitOverlay;
  if (!Array.isArray(src.rules)) return null;
  const hasVoteOnly = !!(src.globalVote || src.localSelf);
  if (src.rules.length === 0 && !hasVoteOnly) return null;

  const rules: MacroExitRule[] = [];
  for (const item of src.rules) {
    if (!item || typeof item !== 'object') continue;
    const ruleRaw = item as MacroExitRule;
    const source = ruleRaw.source === 'anchor' ? 'anchor' : 'self';
    const rule: MacroExitRule = { source };
    if (source === 'anchor') {
      const sym = String(ruleRaw.anchorSymbol || '').trim().toUpperCase();
      if (!sym) continue;
      rule.anchorSymbol = sym;
    }
    rule.rsiPeriod = Math.max(2, Math.floor(asNumber(ruleRaw.rsiPeriod, 14)));
    if (ruleRaw.longExitRsiAbove != null) {
      rule.longExitRsiAbove = clamp(asNumber(ruleRaw.longExitRsiAbove, 0), 0, 100);
    }
    if (ruleRaw.longExitRsiBelow != null) {
      rule.longExitRsiBelow = clamp(asNumber(ruleRaw.longExitRsiBelow, 0), 0, 100);
    }
    if (ruleRaw.shortExitRsiBelow != null) {
      rule.shortExitRsiBelow = clamp(asNumber(ruleRaw.shortExitRsiBelow, 0), 0, 100);
    }
    if (ruleRaw.shortExitRsiAbove != null) {
      rule.shortExitRsiAbove = clamp(asNumber(ruleRaw.shortExitRsiAbove, 0), 0, 100);
    }
    if (ruleRaw.longExitBearishFractal === true) {
      rule.longExitBearishFractal = true;
    }
    if (ruleRaw.shortExitBullishFractal === true) {
      rule.shortExitBullishFractal = true;
    }
    rule.fractalWings = Math.max(1, Math.floor(asNumber(ruleRaw.fractalWings, 2)));
    rule.combineWith = ruleRaw.combineWith === 'or' ? 'or' : 'and';
    rule.mode = ruleRaw.mode === 'partial' ? 'partial' : 'full';
    rule.closeFraction = clamp(asNumber(ruleRaw.closeFraction, 0.5), 0.05, 0.95);
    const label = String(ruleRaw.label || '').trim();
    if (label) rule.label = label;

    const hasRsiThreshold = rule.longExitRsiAbove != null
      || rule.longExitRsiBelow != null
      || rule.shortExitRsiBelow != null
      || rule.shortExitRsiAbove != null;
    const hasFractal = rule.longExitBearishFractal === true || rule.shortExitBullishFractal === true;
    if (!hasRsiThreshold && !hasFractal) continue;
    rules.push(rule);
  }

  if (rules.length === 0 && !src.globalVote && !src.localSelf) return null;
  const anchorInterval = String(src.anchorInterval || '').trim();
  const out: MacroExitOverlay = {
    rules,
    ...(anchorInterval ? { anchorInterval } : {}),
  };
  if (src.globalVote && typeof src.globalVote === 'object') {
    const gv = src.globalVote as MacroExitVoteConfig;
    const anchors = Array.isArray(gv.anchors)
      ? gv.anchors.map((item) => String(item || '').trim().toUpperCase()).filter(Boolean)
      : [];
    if (anchors.length > 0) {
      out.globalVote = {
        minVotes: Math.max(1, Math.floor(asNumber(gv.minVotes, 2))),
        anchors,
        rsiPeriod: Math.max(2, Math.floor(asNumber(gv.rsiPeriod, 14))),
        fractalWings: Math.max(1, Math.floor(asNumber(gv.fractalWings, 2))),
        mode: gv.mode === 'partial' ? 'partial' : 'full',
        closeFraction: clamp(asNumber(gv.closeFraction, 0.5), 0.05, 0.95),
        ...(gv.longExitRsiAbove != null ? { longExitRsiAbove: clamp(asNumber(gv.longExitRsiAbove, 0), 0, 100) } : {}),
        ...(gv.longExitBearishFractal === true ? { longExitBearishFractal: true } : {}),
        ...(gv.shortExitRsiBelow != null ? { shortExitRsiBelow: clamp(asNumber(gv.shortExitRsiBelow, 0), 0, 100) } : {}),
        ...(gv.shortExitRsiAbove != null ? { shortExitRsiAbove: clamp(asNumber(gv.shortExitRsiAbove, 0), 0, 100) } : {}),
        ...(gv.shortExitBullishFractal === true ? { shortExitBullishFractal: true } : {}),
        ...(String(gv.label || '').trim() ? { label: String(gv.label).trim() } : {}),
      };
    }
  }
  if (src.localSelf && typeof src.localSelf === 'object') {
    const ls = src.localSelf as MacroExitRule;
    out.localSelf = {
      source: 'self',
      rsiPeriod: Math.max(2, Math.floor(asNumber(ls.rsiPeriod, 14))),
      fractalWings: Math.max(1, Math.floor(asNumber(ls.fractalWings, 2))),
      mode: ls.mode === 'partial' ? 'partial' : 'full',
      closeFraction: clamp(asNumber(ls.closeFraction, 0.4), 0.05, 0.95),
      combineWith: ls.combineWith === 'or' ? 'or' : 'and',
      ...(ls.longExitRsiAbove != null ? { longExitRsiAbove: clamp(asNumber(ls.longExitRsiAbove, 0), 0, 100) } : {}),
      ...(ls.longExitBearishFractal === true ? { longExitBearishFractal: true } : {}),
      ...(ls.shortExitRsiBelow != null ? { shortExitRsiBelow: clamp(asNumber(ls.shortExitRsiBelow, 0), 0, 100) } : {}),
      ...(ls.shortExitRsiAbove != null ? { shortExitRsiAbove: clamp(asNumber(ls.shortExitRsiAbove, 0), 0, 100) } : {}),
      ...(ls.shortExitBullishFractal === true ? { shortExitBullishFractal: true } : {}),
      ...(String(ls.label || '').trim() ? { label: String(ls.label).trim() } : {}),
    };
  }
  return out;
};

const normalizeStatArbEntryGate = (raw: unknown): StatArbEntryGate | null => {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as StatArbEntryGate;
  const hasFractal = src.longRequireBullishFractal === true || src.shortRequireBearishFractal === true;
  const hasRsi = src.longRsiBelow != null || src.shortRsiAbove != null;
  if (!hasFractal && !hasRsi) return null;
  const gateInterval = String(src.gateInterval || '').trim();
  const anchorSymbol = String(src.anchorSymbol || '').trim().toUpperCase();
  return {
    ...(gateInterval ? { gateInterval } : {}),
    ...(anchorSymbol ? { anchorSymbol } : {}),
    fractalWings: Math.max(1, Math.floor(asNumber(src.fractalWings, 2))),
    lookbackBars: Math.max(4, Math.floor(asNumber(src.lookbackBars, 24))),
    rsiPeriod: Math.max(2, Math.floor(asNumber(src.rsiPeriod, 14))),
    combineWith: src.combineWith === 'and' ? 'and' : 'or',
    ...(src.longRequireBullishFractal === true ? { longRequireBullishFractal: true } : {}),
    ...(src.shortRequireBearishFractal === true ? { shortRequireBearishFractal: true } : {}),
    ...(src.longRsiBelow != null ? { longRsiBelow: clamp(asNumber(src.longRsiBelow, 0), 0, 100) } : {}),
    ...(src.shortRsiAbove != null ? { shortRsiAbove: clamp(asNumber(src.shortRsiAbove, 0), 0, 100) } : {}),
    ...(String(src.label || '').trim() ? { label: String(src.label).trim() } : {}),
  };
};

const hasRecentConfirmedFractal = (
  candles: ParsedCandle[],
  candleIndex: number,
  wings: number,
  lookbackBars: number,
  kind: 'bullish' | 'bearish',
): boolean => {
  const start = Math.max(wings * 2, candleIndex - lookbackBars);
  for (let idx = candleIndex; idx >= start; idx -= 1) {
    if (kind === 'bullish' && hasConfirmedBullishFractal(candles, idx, wings)) return true;
    if (kind === 'bearish' && hasConfirmedBearishFractal(candles, idx, wings)) return true;
  }
  return false;
};

const passesStatArbEntryGate = (
  gate: StatArbEntryGate,
  side: PositionState,
  gateCandles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  if (side !== 'long' && side !== 'short') return true;
  const wings = Math.max(1, Math.floor(gate.fractalWings ?? 2));
  const lookback = Math.max(4, Math.floor(gate.lookbackBars ?? 24));
  const period = Math.max(2, Math.floor(gate.rsiPeriod ?? 14));
  const hasFractal = side === 'long'
    ? gate.longRequireBullishFractal === true
    : gate.shortRequireBearishFractal === true;
  const hasRsi = side === 'long'
    ? gate.longRsiBelow != null
    : gate.shortRsiAbove != null;
  const fractalHit = hasFractal
    ? hasRecentConfirmedFractal(
      gateCandles,
      candleIndex,
      wings,
      lookback,
      side === 'long' ? 'bullish' : 'bearish',
    )
    : false;
  const rsi = hasRsi && candleIndex >= period
    ? computeRsiAtIndex(gateCandles, candleIndex, period)
    : null;
  const rsiHit = hasRsi && rsi != null
    ? (side === 'long'
      ? rsi <= (gate.longRsiBelow as number)
      : rsi >= (gate.shortRsiAbove as number))
    : false;
  if (hasFractal && hasRsi) {
    return gate.combineWith === 'or' ? (fractalHit || rsiHit) : (fractalHit && rsiHit);
  }
  if (hasFractal) return fractalHit;
  return rsiHit;
};

const macroExitRuleKey = (ruleIdx: number, rule: MacroExitRule): string => {
  const label = rule.label || `${rule.source}_${rule.anchorSymbol || 'self'}`;
  return `${ruleIdx}:${label}`;
};

const shouldTriggerMacroExitRsi = (
  rule: MacroExitRule,
  state: PositionState,
  rsi: number,
): boolean => {
  if (state === 'long') {
    if (rule.longExitRsiAbove != null && rsi >= rule.longExitRsiAbove) return true;
    if (rule.longExitRsiBelow != null && rsi <= rule.longExitRsiBelow) return true;
  }
  if (state === 'short') {
    if (rule.shortExitRsiBelow != null && rsi <= rule.shortExitRsiBelow) return true;
    if (rule.shortExitRsiAbove != null && rsi >= rule.shortExitRsiAbove) return true;
  }
  return false;
};

const shouldTriggerMacroExitFractal = (
  rule: MacroExitRule,
  state: PositionState,
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  const wings = Math.max(1, Math.floor(rule.fractalWings ?? 2));
  if (state === 'long' && rule.longExitBearishFractal) {
    return hasConfirmedBearishFractal(candles, candleIndex, wings);
  }
  if (state === 'short' && rule.shortExitBullishFractal) {
    return hasConfirmedBullishFractal(candles, candleIndex, wings);
  }
  return false;
};

const shouldTriggerMacroExit = (
  rule: MacroExitRule,
  state: PositionState,
  rsi: number | null,
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  const hasRsi = rule.longExitRsiAbove != null
    || rule.longExitRsiBelow != null
    || rule.shortExitRsiBelow != null
    || rule.shortExitRsiAbove != null;
  const hasFractal = rule.longExitBearishFractal === true || rule.shortExitBullishFractal === true;
  const rsiHit = hasRsi && rsi != null ? shouldTriggerMacroExitRsi(rule, state, rsi) : false;
  const fractalHit = hasFractal ? shouldTriggerMacroExitFractal(rule, state, candles, candleIndex) : false;
  if (hasRsi && hasFractal) {
    return rule.combineWith === 'or' ? (rsiHit || fractalHit) : (rsiHit && fractalHit);
  }
  if (hasFractal) return fractalHit;
  return rsiHit;
};

const loadAnchorCandlesForMacroExit = async (
  request: NormalizedBacktestRequest,
  symbol: string,
  interval: string,
  candlesLimit: number,
): Promise<ParsedCandle[]> => {
  const raw = await getMarketData(
    request.dataApiKeyName,
    symbol,
    interval,
    candlesLimit,
    {
      startMs: request.dateFromMs ?? undefined,
      endMs: request.dateToMs ?? undefined,
    },
  );
  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseCandle(item))
    .filter((item): item is ParsedCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

/** Deposit equity for DCA % sizing — same reinvest compound as TS, not free-margin base. */
const resolveDcaDepositEquity = (
  ctx: BacktestContext,
  strategy: RuntimeStrategy['strategy'],
  portfolioEquityNow: number,
): number => {
  const maxDeposit = ctx.maxDepositOverride > 0
    ? ctx.maxDepositOverride
    : asNumber(strategy.max_deposit, 0);
  const reinvestShare = resolveReinvestShare(ctx, strategy);
  const equityBaseRaw = ctx.initialBalance
    + Math.max(0, portfolioEquityNow - ctx.initialBalance) * reinvestShare;
  return maxDeposit > 0 ? Math.min(equityBaseRaw, maxDeposit) : equityBaseRaw;
};

/** % депозита (compound) × multiplier; cap only by free margin, not by margin as % base. */
const resolveClassicDcaOrderSize = (
  dc: { baseAmountUsdt: number; baseAmountPercent: number; orderMultiplier: number },
  depositEquityNow: number,
  safetyOrderIndex: number,
  availableCap?: number,
): number => {
  const equityBase = Number.isFinite(depositEquityNow) && depositEquityNow > 0
    ? depositEquityNow
    : dc.baseAmountUsdt;
  const base = dc.baseAmountPercent > 0
    ? Math.max(1, (equityBase * dc.baseAmountPercent) / 100)
    : Math.max(1, dc.baseAmountUsdt);
  const mult = Math.pow(Math.max(1, dc.orderMultiplier), Math.max(0, safetyOrderIndex));
  let size = Math.max(1, base * mult);
  if (Number.isFinite(availableCap) && (availableCap as number) > 0) {
    size = Math.min(size, availableCap as number);
  }
  return size;
};

const extractDcaConfigFromStrategy = (s: any): {
  enabled: boolean; baseAmountUsdt: number; baseAmountPercent: number; stepPercent: number; maxOrders: number;
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
  const pctRaw = Number(s.dca_base_amount_percent || 0);
  const baseAmountPercent = Number.isFinite(pctRaw) && pctRaw > 0 ? Math.max(0.1, pctRaw) : 0;
  if (!Number.isFinite(ba) || ba <= 0) {
    if (baseAmountPercent <= 0) return null;
  }
  const rawFilter = String(s.dca_entry_filter || 'always').trim().toLowerCase();
  const entryFilter = rawFilter === 'rsi_dip' || rawFilter === 'cooldown' ? rawFilter : 'always';
  return {
    enabled: true,
    baseAmountUsdt: Math.max(1, ba),
    baseAmountPercent,
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
  // Prefer signal payload levels when they form a real span.
  // ZZ_Fast/Instance put pivot levelLong/levelShort into donchianHigh/Low (live parity).
  // zz_breakout / Donchian signals already put channel bounds there.
  const payloadHi = Number(signalPayload.donchianHigh);
  const payloadLo = Number(signalPayload.donchianLow);
  const payloadMid = Number(signalPayload.donchianCenter);
  if (
    Number.isFinite(payloadHi)
    && Number.isFinite(payloadLo)
    && payloadHi > payloadLo
    && Number.isFinite(payloadMid)
    && payloadMid > 0
  ) {
    return computeChannelWidthLotMultiplier(payloadHi, payloadLo, payloadMid, strategy as any);
  }
  // Fallback: rebuild Donchian from prior bars (legacy / incomplete payloads).
  const high = signalPayload.donchianCenter > 0
    ? signalPayload.donchianCenter + (signalPayload.current - signalPayload.donchianCenter)
    : signalPayload.current;
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
  /** Macro-exit partial rules already fired for the current open position. */
  macroPartialRulesFired: Set<string>;
  dcaState: ReturnType<typeof extractDcaConfigFromStrategy>;
  zzPivotLevelSeries?: ZzPivotLevels[];
  momentumScalpSeries?: MomentumScalpIndicatorSeries;
  momentumScalpParams?: ReturnType<typeof extractMomentumScalpParams>;
  mrs2Params?: Mrs2Params;
  mrs2Pending?: Mrs2PendingLimits | null;
  mrs2SubBars?: Mrs2SubBarIndex;
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
  reinvestPercentByStrategyId: Map<number, number>;
  initialBalance: number;
  autoLotByChannelWidth: boolean;
  portfolioCircuitBreaker: PortfolioCircuitBreakerTracker | null;
  fatTailSync: FatTailSyncTracker | null;
  researchLotSchedule: ResearchLotScheduleTracker | null;
  channelWidthStopFraction: number;
  /** Lot multiplier from portfolio CB (+ optional fat-tail / research schedule) for the current event (1.0 = full lot). */
  eventCbLotMult: number;
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

/** Free equity for new entries — TS and DCA must share the same wallet cap. */
const portfolioAvailableBalance = (cashEquity: number, runtimes: RuntimeStrategy[]): number => {
  const equityNow = portfolioEquity(cashEquity, runtimes);
  return Math.max(0, equityNow - computeLockedMargin(runtimes));
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
  ctx.fatTailSync?.recordClose(strategyId, netPnl, exitTime);

  runtime.state = 'flat';
  runtime.entryPrice = null;
  runtime.tpAnchorPrice = null;
  runtime.notional = 0;
  runtime.openTrade = null;
  runtime.partialTpTriggered = false;
  runtime.macroPartialRulesFired.clear();
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
  availableCap?: number,
): boolean => {
  const strategy = runtime.strategy;
  const freeMarginCap = Number.isFinite(availableCap) && (availableCap as number) > 0
    ? (availableCap as number)
    : portfolioEquityNow;

  // DCA: % депозита с compound (reinvest), вход только если хватает свободной маржи.
  if (runtime.dcaState?.enabled) {
    const depositEquity = resolveDcaDepositEquity(ctx, strategy, portfolioEquityNow);
    const dcaSize = resolveClassicDcaOrderSize(runtime.dcaState, depositEquity, 0, freeMarginCap);
    if (dcaSize <= 0) return false;
    const entryPrice = executionPrice(marketPrice, signal, 'entry', effectiveSlippageRate(ctx, strategy));
    const entryFee = dcaSize * effectiveCommissionRate(ctx, strategy);
    ctx.cashEquity -= entryFee;
    runtime.state = signal;
    runtime.entryPrice = entryPrice;
    runtime.tpAnchorPrice = marketPrice;
    runtime.notional = dcaSize;
    runtime.partialTpTriggered = false;
    runtime.macroPartialRulesFired = new Set();
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
  const lotPercent = baseLotPercent * multiplier * safeChannelMult * Math.max(0, ctx.eventCbLotMult || 1);

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
  const reinvestShare = resolveReinvestShare(ctx, strategy);
  const equityBaseRaw = strategy.fixed_lot
    ? (maxDeposit > 0 ? maxDeposit : ctx.initialBalance)
    : ctx.initialBalance + Math.max(0, portfolioEquityNow - ctx.initialBalance) * reinvestShare;
  const baseCapital = maxDeposit > 0
    ? Math.min(equityBaseRaw, maxDeposit)
    : equityBaseRaw;

  // Notional = capital × lot_fraction, capped by free margin (not total equity).
  let notional = baseCapital * lotFraction;
  if (Number.isFinite(freeMarginCap) && freeMarginCap > 0) {
    notional = Math.min(notional, freeMarginCap);
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
  runtime.macroPartialRulesFired = new Set();
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

const applyMacroExitRule = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  rule: MacroExitRule,
  ruleKey: string,
  candles: ParsedCandle[],
  candleIndex: number,
  event: StrategyEvent,
  state: PositionState,
  signalPrice: number,
): boolean => {
  const strategy = runtime.strategy;
  if (rule.mode === 'partial' && runtime.macroPartialRulesFired.has(ruleKey)) {
    return false;
  }
  const period = rule.rsiPeriod ?? 14;
  const hasRsi = rule.longExitRsiAbove != null
    || rule.longExitRsiBelow != null
    || rule.shortExitRsiBelow != null
    || rule.shortExitRsiAbove != null;
  const rsi = hasRsi && candleIndex >= period
    ? computeRsiAtIndex(candles, candleIndex, period)
    : null;
  if (!shouldTriggerMacroExit(rule, state, rsi, candles, candleIndex)) {
    return false;
  }

  const reasonParts = [`macro_${rule.label || ruleKey}`];
  if (rsi != null && hasRsi) reasonParts.push(`rsi_${rsi.toFixed(1)}`);
  if (rule.longExitBearishFractal || rule.shortExitBullishFractal) reasonParts.push('fractal');
  const reason = reasonParts.join('_');
  if (rule.mode === 'partial') {
    partialClosePosition(
      ctx,
      runtime,
      Number(strategy.id),
      strategy.name,
      event.timeMs,
      signalPrice,
      reason,
      rule.closeFraction ?? 0.5,
    );
    runtime.macroPartialRulesFired.add(ruleKey);
    return false;
  }

  closePosition(
    ctx,
    runtime,
    Number(strategy.id),
    strategy.name,
    event.timeMs,
    signalPrice,
    reason,
  );
  return true;
};

const evaluateVoteAnchorSignal = (
  vote: MacroExitVoteConfig,
  state: PositionState,
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  const pseudoRule: MacroExitRule = {
    source: 'anchor',
    rsiPeriod: vote.rsiPeriod ?? 14,
    fractalWings: vote.fractalWings ?? 2,
    longExitRsiAbove: vote.longExitRsiAbove,
    longExitBearishFractal: vote.longExitBearishFractal,
    shortExitRsiBelow: vote.shortExitRsiBelow,
    shortExitRsiAbove: vote.shortExitRsiAbove,
    shortExitBullishFractal: vote.shortExitBullishFractal,
    combineWith: 'or',
  };
  const period = pseudoRule.rsiPeriod ?? 14;
  const hasRsi = vote.longExitRsiAbove != null
    || vote.shortExitRsiBelow != null
    || vote.shortExitRsiAbove != null;
  const rsi = hasRsi && candleIndex >= period
    ? computeRsiAtIndex(candles, candleIndex, period)
    : null;
  return shouldTriggerMacroExit(pseudoRule, state, rsi, candles, candleIndex);
};

const applyMacroExitOverlay = (
  ctx: BacktestContext,
  runtime: RuntimeStrategy,
  macroOverlay: MacroExitOverlay,
  anchorCandleCache: Map<string, ParsedCandle[]>,
  event: StrategyEvent,
  state: PositionState,
  signalPrice: number,
): boolean => {
  if (state !== 'long' && state !== 'short') return false;

  const strategy = runtime.strategy;

  if (macroOverlay.globalVote) {
    const vote = macroOverlay.globalVote;
    let votes = 0;
    const voted: string[] = [];
    for (const sym of vote.anchors) {
      const candles = anchorCandleCache.get(sym) || null;
      if (!candles?.length) continue;
      const candleIndex = findCandleIndexAtOrBefore(candles, event.timeMs);
      if (evaluateVoteAnchorSignal(vote, state, candles, candleIndex)) {
        votes += 1;
        voted.push(sym.replace('USDT', ''));
      }
    }
    if (votes >= Math.max(1, vote.minVotes)) {
      const voteKey = `vote:${vote.label || 'global'}:${votes}`;
      if (vote.mode === 'partial') {
        if (!runtime.macroPartialRulesFired.has(voteKey)) {
          partialClosePosition(
            ctx,
            runtime,
            Number(strategy.id),
            strategy.name,
            event.timeMs,
            signalPrice,
            `macro_vote_${votes}of${vote.anchors.length}_${voted.join('+')}`,
            vote.closeFraction ?? 0.5,
          );
          runtime.macroPartialRulesFired.add(voteKey);
        }
      } else {
        closePosition(
          ctx,
          runtime,
          Number(strategy.id),
          strategy.name,
          event.timeMs,
          signalPrice,
          `macro_vote_${votes}of${vote.anchors.length}_${voted.join('+')}`,
        );
        return true;
      }
    }
  }

  if (macroOverlay.localSelf) {
    const rule = macroOverlay.localSelf;
    const ruleKey = `local:${rule.label || 'self'}`;
    if (applyMacroExitRule(
      ctx,
      runtime,
      { ...rule, source: 'self' },
      ruleKey,
      runtime.candles,
      event.candleIndex,
      event,
      state,
      signalPrice,
    )) {
      return true;
    }
  }

  for (let ruleIdx = 0; ruleIdx < macroOverlay.rules.length; ruleIdx++) {
    const rule = macroOverlay.rules[ruleIdx];
    const ruleKey = macroExitRuleKey(ruleIdx, rule);
    if (rule.mode === 'partial' && runtime.macroPartialRulesFired.has(ruleKey)) {
      continue;
    }

    let candles: ParsedCandle[] | null = null;
    let candleIndex = event.candleIndex;
    if (rule.source === 'self') {
      candles = runtime.candles;
    } else if (rule.anchorSymbol) {
      candles = anchorCandleCache.get(rule.anchorSymbol) || null;
      if (candles) {
        candleIndex = findCandleIndexAtOrBefore(candles, event.timeMs);
      }
    }
    if (!candles || candles.length === 0) continue;

    if (applyMacroExitRule(ctx, runtime, rule, ruleKey, candles, candleIndex, event, state, signalPrice)) {
      return true;
    }
  }

  return false;
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
  const lower = normalized.toLowerCase();
  if (
    normalized === 'MeanReversion'
    || normalized === 'MRS2'
    || lower === 'mrs2'
    || lower === 'mrs2_ma_limit'
    || lower === 'meanreversion'
    || lower === 'mean_reversion'
  ) {
    return 'MeanReversion';
  }
  if (normalized === 'stat_arb_zscore' || normalized === 'zz_breakout' || normalized === 'hideep' || normalized === 'CT_Fractal' || normalized === 'momentum_scalp_tv') {
    return normalized;
  }
  if (normalized === 'periodic_buy' || normalized === 'dca') {
    return normalized as StrategyType;
  }
  if (lower === 'zigzag' || lower === 'zig_zag') {
    return 'zz_breakout';
  }
  if (normalized === 'ZZ_Fast' || normalized === 'ZZ_Instance') {
    return normalized;
  }
  if (lower === 'zigzag_fast') return 'ZZ_Fast';
  if (lower === 'zigzag_instance') return 'ZZ_Instance';
  if (normalized === 'ZZ_HAMSTER_ZZ6' || normalized === 'zz_hamster_zz6') {
    return 'ZZ_Fast';
  }
  if (normalized === 'ZZ_HAMSTER_ZZ2' || normalized === 'zz_hamster_zz2') {
    return 'ZZ_Instance';
  }
  // Explicit DD aliases only — never silently map unknown types to DD
  // (July 2026 stamp bug: MeanReversion → DD_BattleToads via this fallthrough).
  if (
    !normalized
    || normalized === 'DD_BattleToads'
    || lower === 'dd_battletoads'
    || lower === 'battletoads'
    || lower === 'double_dragon'
    || lower === 'doubledragon'
  ) {
    return 'DD_BattleToads';
  }
  throw new Error(
    `Unknown strategy_type "${normalized}" — refuse silent DD fallback. `
    + 'Use an explicit known type (MeanReversion, DD_BattleToads, zz_breakout, …).',
  );
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

/** Exchange symbols for symbol-lock (mirrors getStrategyExchangeSymbols). PAIR_LOCK_SCOPE=pair disables. */
const getBacktestExchangeSymbols = (strategy: { market_mode?: any; base_symbol?: any; quote_symbol?: any }): string[] => {
  const base = String(strategy.base_symbol || '').trim().toUpperCase();
  if (!base) return [];
  const mode = normalizeMarketMode(strategy.market_mode);
  if (mode === 'mono') return [base];
  const quote = String(strategy.quote_symbol || '').trim().toUpperCase();
  if (!quote || quote === base) return [base];
  return [base, quote];
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
    const mrs2ParamsForLen = isMrs2StrategyType(strategyTypeForLength)
      ? extractMrs2Params(strategy)
      : null;
    const effectiveLength = (strategyTypeForLength === 'hideep' || strategyTypeForLength === 'CT_Fractal')
      ? Math.max(length + 105, 115)
      : mrs2ParamsForLen
        ? mrs2WarmupBars(mrs2ParamsForLen)
        : length;
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

    // Warmup bars are loaded BEFORE dateFrom (see fetchStartMs). Indicators at
    // firstInRangeIndex already see candles[0..firstInRangeIndex-1] as history —
    // do NOT add warmupBars again on top of the range start (that wrongly skips
    // short sinceFix windows for 4h legs: 13d range < 120×4h warmup extension).
    const range = resolveBacktestRangeIndices({
      effectiveLength,
      warmupBars,
      firstInRangeIndex,
      lastInRangeIndex,
      candlesLength: candles.length,
    });
    if (!range.ok) {
      if (request.skipMissingSymbols) {
        skipped.push({ strategyId: Number(strategy.id), strategyName: strategy.name, reason: range.reason });
        continue;
      }
      throw new Error(`Strategy ${strategy.name}: ${range.reason}`);
    }
    const startIndex = range.startIndex;
    const endIndex = range.endIndex;

    const strategyType = normalizeStrategyType(strategy.strategy_type);
    const zzPivotLevelSeries = isZzPivotStrategyType(normalizeZzPivotStrategyType(strategyType) as StrategyType)
      ? buildZzPivotLevelSeries(candles, Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 6))), zzPivotVariantFromType(strategyType))
      : undefined;
    const momentumScalpParams = isMomentumScalpStrategyType(strategyType)
      ? extractMomentumScalpParams(strategy)
      : undefined;
    const momentumScalpSeries = momentumScalpParams
      ? buildMomentumScalpIndicatorSeries(candles, momentumScalpParams)
      : undefined;
    const mrs2Params = isMrs2StrategyType(strategyType)
      ? extractMrs2Params(strategy)
      : undefined;
    const sameBarExitMode = resolveMrs2SameBarExitMode();
    const mrs2SubBars = mrs2Params && (sameBarExitMode === 'path' || sameBarExitMode === 'path_lenient')
      ? loadMrs2SubBarIndex(strategy.base_symbol, interval)
      : undefined;

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
      macroPartialRulesFired: new Set(),
      dcaState: extractDcaConfigFromStrategy(strategy),
      zzPivotLevelSeries,
      momentumScalpSeries,
      momentumScalpParams,
      mrs2Params,
      mrs2Pending: null,
      mrs2SubBars,
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
  const maxOpenPositionsByBook = (() => {
    const map = new Map<string, number>();
    const src = raw.maxOpenPositionsByBook;
    if (src && typeof src === 'object') {
      for (const [key, value] of Object.entries(src)) {
        const book = String(key || '').trim();
        const lim = Math.max(0, Math.floor(Number(value)));
        if (book && Number.isFinite(lim)) map.set(book, lim);
      }
    }
    return map;
  })();
  const bookKeyByStrategyId = (() => {
    const map = new Map<number, string>();
    const src = raw.bookKeyByStrategyId;
    if (src && typeof src === 'object') {
      for (const [key, value] of Object.entries(src)) {
        const sid = Number(key);
        const book = String(value || '').trim();
        if (Number.isFinite(sid) && sid > 0 && book) map.set(sid, book);
      }
    }
    return map;
  })();
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
    maxOpenPositionsByBook,
    bookKeyByStrategyId,
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
            map.set(sid, Math.max(0, Math.min(LOT_PERCENT_MULTIPLIER_MAX, mul)));
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
    reinvestPercentByStrategyId: (() => {
      const map = new Map<number, number>();
      const src = (raw as { reinvestPercentByStrategyId?: unknown })?.reinvestPercentByStrategyId;
      if (src && typeof src === 'object') {
        for (const [key, value] of Object.entries(src as Record<string, unknown>)) {
          const sid = Number(key);
          const n = Number(value);
          if (Number.isFinite(sid) && sid > 0 && Number.isFinite(n) && n >= 0) {
            map.set(sid, Math.min(100, n));
          }
        }
      }
      return map;
    })(),
    partialTpPct,
    macroExitOverlay: normalizeMacroExitOverlay(raw.macroExitOverlay),
    statArbEntryGate: normalizeStatArbEntryGate((raw as { statArbEntryGate?: unknown }).statArbEntryGate),
    orderBlockEntryGate: normalizeOrderBlockEntryGate((raw as { orderBlockEntryGate?: unknown }).orderBlockEntryGate),
    autoLotByChannelWidth: raw.autoLotByChannelWidth === true,
    enablePairLock: (raw as unknown as { enablePairLock?: boolean })?.enablePairLock !== false,
    pairLockSeed: Math.max(
      1,
      Math.floor(asNumber((raw as unknown as { pairLockSeed?: number })?.pairLockSeed, 1759827600)),
    ),
    portfolioCircuitBreaker: parsePortfolioCircuitBreaker(
      (raw as { portfolioCircuitBreaker?: unknown }).portfolioCircuitBreaker,
    ),
    fatTailSyncCooldown: parseFatTailSync(
      (raw as { fatTailSyncCooldown?: unknown }).fatTailSyncCooldown,
    ),
    researchLotSchedule: parseResearchLotSchedule(
      (raw as { researchLotSchedule?: unknown }).researchLotSchedule,
    ),
    channelWidthStopFraction: (() => {
      const n = Number((raw as { channelWidthStopFraction?: unknown }).channelWidthStopFraction);
      return Number.isFinite(n) && n > 0 ? Math.min(2, n) : 0;
    })(),
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

  const mrs2SameBarExitMode = resolveMrs2SameBarExitMode();
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
    reinvestPercentByStrategyId: request.reinvestPercentByStrategyId,
    initialBalance: request.initialBalance,
    autoLotByChannelWidth: request.autoLotByChannelWidth,
    portfolioCircuitBreaker: PortfolioCircuitBreakerTracker.tryCreate(request.portfolioCircuitBreaker),
    fatTailSync: FatTailSyncTracker.tryCreate(request.fatTailSyncCooldown),
    researchLotSchedule: ResearchLotScheduleTracker.tryCreate(request.researchLotSchedule),
    channelWidthStopFraction: request.channelWidthStopFraction,
    eventCbLotMult: 1,
  };

  const maxOpenPositions = request.maxOpenPositions;
  const maxOpenPositionsByBook = request.maxOpenPositionsByBook;
  const bookKeyByRuntimeIndex: Array<string | null> = runtimes.map((rt) => {
    const sid = Number(rt.strategy.id);
    return request.bookKeyByStrategyId.get(sid) || null;
  });
  const partialTpPct = request.partialTpPct;
  const macroOverlay = request.macroExitOverlay;
  const anchorCandleCache = new Map<string, ParsedCandle[]>();
  const anchorInterval = macroOverlay?.anchorInterval
    || String(runtimes[0]?.strategy.interval || '4h');
  const candlesLimit = Math.max(request.bars + request.warmupBars + 500, 2000);
  const anchorSymbols = new Set<string>();
  if (macroOverlay) {
    for (const rule of macroOverlay.rules) {
      if (rule.source === 'anchor' && rule.anchorSymbol) {
        anchorSymbols.add(rule.anchorSymbol);
      }
    }
    if (macroOverlay.globalVote?.anchors) {
      for (const sym of macroOverlay.globalVote.anchors) {
        anchorSymbols.add(sym);
      }
    }
  }
  if (anchorSymbols.size > 0) {
    for (const sym of anchorSymbols) {
      try {
        const candles = await loadAnchorCandlesForMacroExit(
          request,
          sym,
          anchorInterval,
          candlesLimit,
        );
        if (candles.length > 0) {
          anchorCandleCache.set(sym, candles);
        }
      } catch (error) {
        logger.warn(`macro exit: failed to load anchor ${sym}: ${(error as Error).message}`);
      }
    }
  }

  const statArbEntryGate = request.statArbEntryGate;
  const orderBlockEntryGate = request.orderBlockEntryGate;
  const gateCandleCache = new Map<string, ParsedCandle[]>();
  if (statArbEntryGate) {
    const gateInterval = statArbEntryGate.gateInterval
      || String(runtimes[0]?.strategy.interval || '4h');
    const gateSymbols = new Set<string>();
    if (statArbEntryGate.anchorSymbol) {
      gateSymbols.add(statArbEntryGate.anchorSymbol);
    } else {
      for (const rt of runtimes) {
        if (normalizeStrategyType(rt.strategy.strategy_type) !== 'stat_arb_zscore') continue;
        if (normalizeMarketMode(rt.strategy.market_mode) === 'synthetic') continue;
        const sym = String(rt.strategy.base_symbol || '').trim().toUpperCase();
        if (sym) gateSymbols.add(sym);
      }
    }
    for (const sym of gateSymbols) {
      const cacheKey = `${sym}:${gateInterval}`;
      if (gateCandleCache.has(cacheKey)) continue;
      try {
        const candles = await loadAnchorCandlesForMacroExit(
          request,
          sym,
          gateInterval,
          candlesLimit,
        );
        if (candles.length > 0) {
          gateCandleCache.set(cacheKey, candles);
        }
      } catch (error) {
        logger.warn(`stat arb entry gate: failed to load ${sym}@${gateInterval}: ${(error as Error).message}`);
      }
    }
  }
  if (orderBlockEntryGate) {
    const obInterval = String(orderBlockEntryGate.gateInterval || '4h').trim() || '4h';
    if (orderBlockEntryGate.useSelf) {
      for (const rt of runtimes) {
        if (normalizeMarketMode(rt.strategy.market_mode) === 'synthetic') continue;
        const sym = String(rt.strategy.base_symbol || '').trim().toUpperCase();
        if (!sym) continue;
        const cacheKey = `${sym}:${obInterval}`;
        if (gateCandleCache.has(cacheKey)) continue;
        try {
          const candles = await loadAnchorCandlesForMacroExit(
            request,
            sym,
            obInterval,
            candlesLimit,
          );
          if (candles.length > 0) {
            gateCandleCache.set(cacheKey, candles);
          }
        } catch (error) {
          logger.warn(`order block gate: failed to load ${sym}@${obInterval}: ${(error as Error).message}`);
        }
      }
    } else {
      const obSym = String(orderBlockEntryGate.anchorSymbol || 'BTCUSDT').trim().toUpperCase();
      const cacheKey = `${obSym}:${obInterval}`;
      if (!gateCandleCache.has(cacheKey)) {
        try {
          const candles = await loadAnchorCandlesForMacroExit(
            request,
            obSym,
            obInterval,
            candlesLimit,
          );
          if (candles.length > 0) {
            gateCandleCache.set(cacheKey, candles);
          }
        } catch (error) {
          logger.warn(`order block gate: failed to load ${obSym}@${obInterval}: ${(error as Error).message}`);
        }
      }
    }
  }

  let skippedByPositionLimit = 0;
  let skippedByOrderBlockGate = 0;
  let skippedByPairLock = 0;

  // Precompute pair keys per runtime so we can do O(N) pair-lock check per signal.
  // Mirrors runtime `getStrategyPairKey` in bot/strategy.ts so backtest matches live behavior.
  const pairKeyByRuntimeIndex: string[] = runtimes.map((rt) => getBacktestPairKey(rt.strategy));
  // Symbol-lock: exchange symbols per runtime for mono↔synth overlap (PAIR_LOCK_SCOPE=pair → old behavior).
  const useSymbolLock = process.env.PAIR_LOCK_SCOPE !== 'pair';
  const exchangeSymsByRuntimeIndex: string[][] = runtimes.map((rt) => getBacktestExchangeSymbols(rt.strategy));

  /** Classic DCA grids use fixed base USDT sizing — they do not consume TS max-open-position slots. */
  const countsTowardOpLimit = (rt: RuntimeStrategy): boolean => !rt.dcaState?.enabled;

  const countOpenPositions = (): number => {
    return runtimes.filter((rt) => rt.state !== 'flat' && countsTowardOpLimit(rt)).length;
  };

  const countOpenPositionsInBook = (bookKey: string): number => {
    return runtimes.filter((rt, idx) => (
      rt.state !== 'flat'
      && countsTowardOpLimit(rt)
      && bookKeyByRuntimeIndex[idx] === bookKey
    )).length;
  };

  /** Shared-margin portfolio: per-book OP first, then optional global OP hard cap. */
  const canOpenNewPosition = (strategyIndex: number): boolean => {
    const bookKey = bookKeyByRuntimeIndex[strategyIndex];
    if (bookKey && maxOpenPositionsByBook.has(bookKey)) {
      const bookLimit = Number(maxOpenPositionsByBook.get(bookKey) || 0);
      if (bookLimit > 0 && countOpenPositionsInBook(bookKey) >= bookLimit) {
        return false;
      }
    }
    if (maxOpenPositions > 0 && countOpenPositions() >= maxOpenPositions) {
      return false;
    }
    // If neither global nor book OP is set, unlimited.
    return true;
  };

  const isPairLocked = (selfIndex: number, pairKey: string): boolean => {
    if (!pairKey) return false;
    if (useSymbolLock) {
      const mySyms = exchangeSymsByRuntimeIndex[selfIndex];
      if (mySyms.length === 0) return false;
      for (let i = 0; i < runtimes.length; i++) {
        if (i === selfIndex) continue;
        if (runtimes[i].state === 'flat') continue;
        const otherSyms = exchangeSymsByRuntimeIndex[i];
        for (const sym of mySyms) {
          if (otherSyms.includes(sym)) return true;
        }
      }
      return false;
    }
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
    const unrealized = runtimes.reduce((sum, runtime) => sum + unrealizedPnl(runtime), 0);
    const value = Math.max(0, portfolioEquity(ctx.cashEquity, runtimes));
    equityCurve.push({
      time: Math.floor(timeMs / 1000),
      equity: value,
      cashEquity: ctx.cashEquity,
      unrealizedPnl: unrealized,
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

    const equityForCb = portfolioEquity(ctx.cashEquity, runtimes);
    const cbRaw = ctx.portfolioCircuitBreaker
      ? ctx.portfolioCircuitBreaker.update(equityForCb, event.timeMs).lotMultiplier
      : 1;
    const cbTiered = ctx.portfolioCircuitBreaker
      ? ctx.portfolioCircuitBreaker.lotMultiplierForStrategyType(strategyType, cbRaw)
      : 1;
    const fatMult = ctx.fatTailSync
      ? ctx.fatTailSync.lotMultiplierFor(strategy, event.timeMs)
      : 1;
    const researchMult = ctx.researchLotSchedule
      ? ctx.researchLotSchedule.lotMultiplierFor(strategy, event.timeMs)
      : 1;
    ctx.eventCbLotMult = Math.max(0, cbTiered) * Math.max(0, fatMult) * Math.max(0, researchMult);

    const length = Math.max(2, Math.floor(asNumber(strategy.price_channel_length, 50)));
    const zscoreEntry = normalizeZscoreEntry(strategy.zscore_entry);

    const isZzPivot = isZzPivotStrategyType(normalizeZzPivotStrategyType(strategyType) as StrategyType);

    const isStatArb = strategyType === 'stat_arb_zscore' || strategyType === 'CT_Fractal';
    const isCtFractal = strategyType === 'CT_Fractal';
    const isMomentumScalp = isMomentumScalpStrategyType(strategyType);
    const isMrs2 = isMrs2StrategyType(strategyType);
    const zscoreExit = normalizeZscoreExit(strategy.zscore_exit, zscoreEntry);
    const zscoreStop = normalizeZscoreStop(strategy.zscore_stop, zscoreEntry);
    const state = runtime.state;
    const entryPrice = runtime.entryPrice;
    const takeProfitPercent = Math.max(0, asNumber(strategy.take_profit_percent, 0));

    // MRS2: dedicated limit-fill path (sticky entry limits; exit at close-MA)
    if (!isClassicDca && isMrs2 && runtime.mrs2Params) {
      const action = evaluateMrs2Bar(
        runtime.candles,
        event.candleIndex,
        runtime.mrs2Params,
        state === 'long' || state === 'short' ? state : 'flat',
        entryPrice,
        runtime.mrs2Pending ?? null,
      );
      runtime.mrs2Pending = action.pending;
      if (action.exit && (state === 'long' || state === 'short')) {
        closePosition(
          ctx,
          runtime,
          Number(strategy.id),
          strategy.name,
          event.timeMs,
          action.exitPrice,
          action.exitReason || 'mrs2_exit',
        );
        runtime.mrs2Pending = null;
        pushEquityPoint(event.timeMs);
        continue;
      }
      if (runtime.state === 'flat' && (action.signal === 'long' || action.signal === 'short')) {
        if (!canOpenNewPosition(event.strategyIndex)) {
          skippedByPositionLimit++;
          pushEquityPoint(event.timeMs);
          continue;
        }
        if (request.enablePairLock) {
          const pairKey = pairKeyByRuntimeIndex[event.strategyIndex];
          if (isPairLocked(event.strategyIndex, pairKey)) {
            skippedByPairLock++;
            pushEquityPoint(event.timeMs);
            continue;
          }
        }
        const fillPx = Number(action.fillPrice);
        if (!Number.isFinite(fillPx) || fillPx <= 0) {
          pushEquityPoint(event.timeMs);
          continue;
        }
        const entrySide = action.signal;
        const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
        const availableBalance = portfolioAvailableBalance(ctx.cashEquity, runtimes);
        const opened = openPosition(
          ctx,
          runtime,
          entrySide,
          event.timeMs,
          fillPx,
          equityNow,
          1,
          availableBalance,
        );
        runtime.mrs2Pending = null;
        // Same-bar TP: after limit entry, allow close-MA exit if also touched this bar.
        if (opened && runtime.entryPrice && mrs2SameBarExitMode !== 'block') {
          const exitAction = evaluateMrs2Bar(
            runtime.candles,
            event.candleIndex,
            runtime.mrs2Params,
            entrySide,
            runtime.entryPrice,
            null,
          );
          const sameBarExitAllowed = exitAction.exit && (
            mrs2SameBarExitMode === 'allow'
            || mrs2SameBarExitConfirmed(
              runtime.mrs2SubBars,
              event.timeMs,
              entrySide,
              runtime.entryPrice,
              exitAction.exitPrice,
              mrs2SameBarExitMode === 'path_lenient',
            )
          );
          if (sameBarExitAllowed) {
            closePosition(
              ctx,
              runtime,
              Number(strategy.id),
              strategy.name,
              event.timeMs,
              exitAction.exitPrice,
              exitAction.exitReason || 'mrs2_exit',
            );
            runtime.mrs2Pending = null;
          }
        }
      }
      pushEquityPoint(event.timeMs);
      continue;
    }

    const signalPayload = computeSignalAtIndex(
      strategyType,
      runtime.candles,
      event.candleIndex,
      length,
      strategy.detection_source,
      zscoreEntry,
      strategy.long_enabled,
      strategy.short_enabled,
      runtime.zzPivotLevelSeries,
      isMomentumScalp
        ? {
            params: runtime.momentumScalpParams,
            series: runtime.momentumScalpSeries,
            positionSide: state,
            zscoreExit: asNumber(strategy.zscore_exit, 20),
            zscoreStop: asNumber(strategy.zscore_stop, 1.2),
            takeProfitPercent,
          }
        : undefined,
    );

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

    // Macro RSI exit overlay (self symbol + BTC/ETH/SOL anchors)
    if (!isClassicDca && !closedOnCurrentBar && macroOverlay && (state === 'long' || state === 'short')) {
      if (applyMacroExitOverlay(ctx, runtime, macroOverlay, anchorCandleCache, event, state, signalPayload.current)) {
        closedOnCurrentBar = true;
      }
    }

    // TV momentum scalp: fixed TP/SL on closed-bar close + optional opposite EMA cross
    // (matches live strategy.ts — no wick fills).
    if (!isClassicDca && !closedOnCurrentBar && isMomentumScalp && (state === 'long' || state === 'short') && entryPrice && runtime.momentumScalpParams) {
      const msParams = runtime.momentumScalpParams;
      const { tp, sl } = momentumScalpTpSlPrices(state, entryPrice, msParams);
      const px = signalPayload.current;
      if (state === 'long') {
        if (px <= sl) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_sl_long');
          closedOnCurrentBar = true;
        } else if (px >= tp) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_tp_long');
          closedOnCurrentBar = true;
        } else if (msParams.exitOnOppositeCross && signalPayload.oppositeCross) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_cross_long');
          closedOnCurrentBar = true;
        }
      } else if (!closedOnCurrentBar) {
        if (px >= sl) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_sl_short');
          closedOnCurrentBar = true;
        } else if (px <= tp) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_tp_short');
          closedOnCurrentBar = true;
        } else if (msParams.exitOnOppositeCross && signalPayload.oppositeCross) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, px, 'ms_cross_short');
          closedOnCurrentBar = true;
        }
      }
    }

    // Partial TP: applies to non-DCA strategy types (not momentum burst)
    if (!isClassicDca && !isMomentumScalp && !closedOnCurrentBar && !runtime.partialTpTriggered && partialTpPct > 0 && (state === 'long' || state === 'short') && entryPrice && entryPrice > 0) {
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
    } else if (!isClassicDca && !isMomentumScalp) {
      // ZZ pivot SAR exit (opposite level)
      if (!closedOnCurrentBar && isZzPivot) {
        const levels = runtime.zzPivotLevelSeries?.[event.candleIndex];
        if (levels) {
          if (state === 'long' && candle.low <= levels.levelShort) {
            closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'zz_sar_long');
            closedOnCurrentBar = true;
          }
          if (!closedOnCurrentBar && state === 'short' && candle.high >= levels.levelLong) {
            closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, 'zz_sar_short');
            closedOnCurrentBar = true;
          }
        }
      }

      // HiDeep RSI-based exit: fastRSI (stored in zScore) crosses overbought/oversold
      if ((strategyType === 'hideep' || isCtFractal) && Number.isFinite(isCtFractal ? signalPayload.fastRsi : signalPayload.zScore)) {
        const fastRsi = isCtFractal ? Number(signalPayload.fastRsi) : Number(signalPayload.zScore);
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

      if (!closedOnCurrentBar && !isZzPivot && state === 'long' && entryPrice) {
        const hi = Number(signalPayload.donchianHigh);
        const lo = Number(signalPayload.donchianLow);
        const frac = ctx.channelWidthStopFraction;
        let hit = false;
        let reason = 'stop_loss_long_center';
        if (frac > 0 && Number.isFinite(hi) && Number.isFinite(lo) && hi > lo) {
          const stopPx = entryPrice - (hi - lo) * frac;
          hit = signalPayload.current <= stopPx;
          reason = `stop_loss_long_chanfrac_${frac}`;
        } else {
          hit = signalPayload.current <= signalPayload.donchianCenter;
        }
        if (hit) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, reason);
          closedOnCurrentBar = true;
        }
      }

      if (!closedOnCurrentBar && !isZzPivot && state === 'short' && entryPrice) {
        const hi = Number(signalPayload.donchianHigh);
        const lo = Number(signalPayload.donchianLow);
        const frac = ctx.channelWidthStopFraction;
        let hit = false;
        let reason = 'stop_loss_short_center';
        if (frac > 0 && Number.isFinite(hi) && Number.isFinite(lo) && hi > lo) {
          const stopPx = entryPrice + (hi - lo) * frac;
          hit = signalPayload.current >= stopPx;
          reason = `stop_loss_short_chanfrac_${frac}`;
        } else {
          hit = signalPayload.current >= signalPayload.donchianCenter;
        }
        if (hit) {
          closePosition(ctx, runtime, Number(strategy.id), strategy.name, event.timeMs, signalPayload.current, reason);
          closedOnCurrentBar = true;
        }
      }
    }


    // DCA safety order
    if (!closedOnCurrentBar && runtime.dcaState && runtime.state !== 'flat' &&
        runtime.dcaState.lastBuyPrice > 0 && runtime.dcaState.ordersCount < runtime.dcaState.maxOrders) {
      const dc = runtime.dcaState;
      const stepTrigger = dc.lastBuyPrice * (1 - dc.stepPercent / 100);
      if (candle.close <= stepTrigger) {
        const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
        const depositEquity = resolveDcaDepositEquity(ctx, runtime.strategy, equityNow);
        const availableNow = portfolioAvailableBalance(ctx.cashEquity, runtimes);
        const cbMult = Math.max(0, ctx.eventCbLotMult || 1);
        let safetySize = resolveClassicDcaOrderSize(dc, depositEquity, dc.ordersCount, availableNow);
        safetySize *= cbMult;
        if (safetySize <= 0) {
          pushEquityPoint(event.timeMs);
          continue;
        }
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
              const availableNow = portfolioAvailableBalance(ctx.cashEquity, runtimes);
              openPosition(ctx, runtime, 'long', event.timeMs, candle.close, equityNow, 1, availableNow);
            }
          } else {
            const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
            const availableNow = portfolioAvailableBalance(ctx.cashEquity, runtimes);
            openPosition(ctx, runtime, 'long', event.timeMs, candle.close, equityNow, 1, availableNow);
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

    if (isZzPivot && state !== 'flat') {
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
      // CT re-entry cooldown (parity with live CT_REENTRY_MIN_BARS). Default 0 = same-bar only.
      if (isCtFractal) {
        const minBars = Math.max(0, Math.floor(Number(process.env.CT_REENTRY_MIN_BARS || 0) || 0));
        if (minBars > 0) {
          (runtime as any).ctReentryCooldownBarsLeft = minBars;
        }
      }
      pushEquityPoint(event.timeMs);
      continue;
    }

    // Multi-bar CT re-entry cooldown after exit (skip entries while countdown > 0).
    if (isCtFractal && runtime.state === 'flat') {
      const left = Math.max(0, Math.floor(Number((runtime as any).ctReentryCooldownBarsLeft || 0) || 0));
      if (left > 0) {
        (runtime as any).ctReentryCooldownBarsLeft = left - 1;
        pushEquityPoint(event.timeMs);
        continue;
      }
    }

    // Position Limiter (ОП): per-book and/or global max open positions
    if (runtime.state === 'flat' && !canOpenNewPosition(event.strategyIndex)) {
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

    if (isStatArb && !isCtFractal && statArbEntryGate
      && (signalPayload.signal === 'long' || signalPayload.signal === 'short')) {
      const gateInterval = statArbEntryGate.gateInterval
        || String(strategy.interval || '4h');
      const mode = normalizeMarketMode(strategy.market_mode);
      let gateCandles: ParsedCandle[];
      let gateIndex: number;
      if (statArbEntryGate.anchorSymbol) {
        const gateSymbol = statArbEntryGate.anchorSymbol;
        const cacheKey = `${gateSymbol}:${gateInterval}`;
        gateCandles = gateCandleCache.get(cacheKey) || runtime.candles;
        gateIndex = gateCandles === runtime.candles
          ? event.candleIndex
          : findCandleIndexAtOrBefore(gateCandles, event.timeMs);
      } else if (mode === 'synthetic') {
        gateCandles = runtime.candles;
        gateIndex = event.candleIndex;
      } else {
        const gateSymbol = String(strategy.base_symbol || '').trim().toUpperCase();
        const cacheKey = `${gateSymbol}:${gateInterval}`;
        gateCandles = gateCandleCache.get(cacheKey) || runtime.candles;
        gateIndex = gateCandles === runtime.candles
          ? event.candleIndex
          : findCandleIndexAtOrBefore(gateCandles, event.timeMs);
      }
      if (!passesStatArbEntryGate(
        statArbEntryGate,
        signalPayload.signal,
        gateCandles,
        gateIndex,
      )) {
        pushEquityPoint(event.timeMs);
        continue;
      }
    }

    if (orderBlockEntryGate
      && (signalPayload.signal === 'long' || signalPayload.signal === 'short')) {
      const obInterval = String(orderBlockEntryGate.gateInterval || '4h').trim() || '4h';
      const obSym = orderBlockEntryGate.useSelf
        ? String(strategy.base_symbol || '').trim().toUpperCase()
        : String(orderBlockEntryGate.anchorSymbol || 'BTCUSDT').trim().toUpperCase();
      if (obSym) {
        const cacheKey = `${obSym}:${obInterval}`;
        const obCandles = gateCandleCache.get(cacheKey) || [];
        const obIndex = findCandleIndexAtOrBefore(obCandles, event.timeMs);
        if (obCandles.length >= 30 && obIndex >= 0
          && !passesOrderBlockEntryGate(
            orderBlockEntryGate,
            signalPayload.signal,
            obCandles,
            obIndex,
          )) {
          skippedByOrderBlockGate += 1;
          pushEquityPoint(event.timeMs);
          continue;
        }
      }
    }

    const equityNow = portfolioEquity(ctx.cashEquity, runtimes);
    const availableBalance = portfolioAvailableBalance(ctx.cashEquity, runtimes);
    const lotChannelMult = resolveAutoLotChannelWidthMult(runtime, event.candleIndex, strategy, ctx, signalPayload);
    openPosition(ctx, runtime, signalPayload.signal, event.timeMs, signalPayload.current, equityNow, lotChannelMult, availableBalance);
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
    skippedStrategyDetails: runtimeLoad.skipped,
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
    skippedByOrderBlockGate,
    ...(ctx.portfolioCircuitBreaker
      ? { portfolioCircuitBreakerTriggers: ctx.portfolioCircuitBreaker.getTriggerCount() }
      : {}),
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
    skippedByOrderBlockGate: 0,
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

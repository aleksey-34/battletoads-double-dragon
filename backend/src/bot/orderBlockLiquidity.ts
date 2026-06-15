/**
 * Simple SMC-style liquidity zones (order blocks / EQH-EQL sweeps).
 * Artur rule: liquidity pools + EMA → fade reversal unless bar is panic-sized.
 */

export type OrderBlockEntryGate = {
  gateInterval?: string;
  /** Anchor symbol (BTC). Ignored when useSelf=true. */
  anchorSymbol?: string;
  /** Per-pair gate: use strategy's own symbol candles. */
  useSelf?: boolean;
  /** orderblock = EQH/EQL sweep; range = Donchian position; combined = either blocks. */
  gateMode?: 'orderblock' | 'range' | 'combined';
  fractalWings?: number;
  swingLookbackBars?: number;
  eqTolerancePercent?: number;
  sweepMinPercent?: number;
  emaPeriod?: number;
  requireEmaAlign?: boolean;
  blockLongAtSupply?: boolean;
  blockShortAtDemand?: boolean;
  panicMaxRangePercent?: number;
  /** Range gate: lookback bars for high/low channel. */
  rangeLookbackBars?: number;
  /** Block long when close in top X% of range (default 82). */
  blockLongRangeAbove?: number;
  /** Block short when close in bottom X% of range (default 18). */
  blockShortRangeBelow?: number;
  label?: string;
};

export const DEFAULT_ORDER_BLOCK_ENTRY_GATE: OrderBlockEntryGate = {
  gateInterval: '4h',
  anchorSymbol: 'BTCUSDT',
  gateMode: 'orderblock',
  fractalWings: 2,
  swingLookbackBars: 48,
  eqTolerancePercent: 0.35,
  sweepMinPercent: 0.05,
  emaPeriod: 50,
  requireEmaAlign: true,
  blockLongAtSupply: true,
  blockShortAtDemand: true,
  panicMaxRangePercent: 2.5,
  label: 'btc_liq_ob_4h',
};

/** Per-pair range fade gate (research winner on Artur losses). */
export const DEFAULT_LOCAL_RANGE_ENTRY_GATE: OrderBlockEntryGate = {
  gateInterval: '4h',
  useSelf: true,
  gateMode: 'range',
  rangeLookbackBars: 48,
  blockLongRangeAbove: 82,
  blockShortRangeBelow: 18,
  label: 'self_range_4h_82_18',
};

export const DEFAULT_COMBINED_LIQUIDITY_GATE: OrderBlockEntryGate = {
  ...DEFAULT_LOCAL_RANGE_ENTRY_GATE,
  gateMode: 'combined',
  fractalWings: 2,
  swingLookbackBars: 48,
  eqTolerancePercent: 0.35,
  sweepMinPercent: 0.05,
  emaPeriod: 50,
  requireEmaAlign: false,
  blockLongAtSupply: true,
  blockShortAtDemand: true,
  panicMaxRangePercent: 2.5,
  label: 'self_range_ob_4h',
};

type ParsedCandle = { timeMs: number; open: number; high: number; low: number; close: number };

const clamp = (v: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, v));

export const normalizeOrderBlockEntryGate = (raw: unknown): OrderBlockEntryGate | null => {
  if (!raw || typeof raw !== 'object') return null;
  const src = raw as OrderBlockEntryGate;
  const useSelf = src.useSelf === true;
  const anchor = String(src.anchorSymbol || '').trim().toUpperCase();
  if (!useSelf && !anchor) return null;
  const gateMode = src.gateMode === 'range' || src.gateMode === 'combined'
    ? src.gateMode
    : 'orderblock';
  return {
    gateInterval: String(src.gateInterval || '4h').trim() || '4h',
    ...(useSelf ? { useSelf: true } : { anchorSymbol: anchor }),
    gateMode,
    fractalWings: Math.max(1, Math.floor(Number(src.fractalWings ?? 2))),
    swingLookbackBars: Math.max(12, Math.floor(Number(src.swingLookbackBars ?? 48))),
    eqTolerancePercent: clamp(Number(src.eqTolerancePercent ?? 0.35), 0.05, 2),
    sweepMinPercent: clamp(Number(src.sweepMinPercent ?? 0.05), 0, 1),
    emaPeriod: Math.max(5, Math.floor(Number(src.emaPeriod ?? 50))),
    requireEmaAlign: src.requireEmaAlign !== false,
    blockLongAtSupply: src.blockLongAtSupply !== false,
    blockShortAtDemand: src.blockShortAtDemand !== false,
    panicMaxRangePercent: clamp(Number(src.panicMaxRangePercent ?? 2.5), 0.5, 10),
    rangeLookbackBars: Math.max(12, Math.floor(Number(src.rangeLookbackBars ?? 48))),
    blockLongRangeAbove: clamp(Number(src.blockLongRangeAbove ?? 82), 50, 99),
    blockShortRangeBelow: clamp(Number(src.blockShortRangeBelow ?? 18), 1, 50),
    ...(String(src.label || '').trim() ? { label: String(src.label).trim() } : {}),
  };
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

const clusterLiquidityLevel = (levels: number[], tolerancePercent: number, pick: 'high' | 'low'): number | null => {
  if (levels.length < 2) return levels.length === 1 ? levels[0] : null;
  const sorted = [...levels].sort((a, b) => a - b);
  let bestCluster: number[] = [];
  for (let i = 0; i < sorted.length; i += 1) {
    const cluster = [sorted[i]];
    for (let j = i + 1; j < sorted.length; j += 1) {
      const mid = (sorted[i] + sorted[j]) / 2;
      if (mid <= 0) continue;
      if (Math.abs(sorted[j] - sorted[i]) / mid * 100 <= tolerancePercent) {
        cluster.push(sorted[j]);
      }
    }
    if (cluster.length > bestCluster.length) bestCluster = cluster;
  }
  if (bestCluster.length < 2) {
    return pick === 'high' ? Math.max(...sorted) : Math.min(...sorted);
  }
  return pick === 'high' ? Math.max(...bestCluster) : Math.min(...bestCluster);
};

const emaAt = (closes: number[], endIndex: number, period: number): number | null => {
  if (endIndex < period - 1 || closes.length <= endIndex) return null;
  const k = 2 / (period + 1);
  let ema = closes[endIndex - period + 1];
  for (let i = endIndex - period + 2; i <= endIndex; i += 1) {
    ema = closes[i] * k + ema * (1 - k);
  }
  return ema;
};

const isPanicBar = (candle: ParsedCandle, panicMaxRangePercent: number): boolean => {
  if (candle.close <= 0) return false;
  return ((candle.high - candle.low) / candle.close) * 100 >= panicMaxRangePercent;
};

export type OrderBlockSignals = {
  supplyRejection: boolean;
  demandRejection: boolean;
  supplyLevel: number | null;
  demandLevel: number | null;
  rangePos: number | null;
  nearSupply: boolean;
  nearDemand: boolean;
};

export const rangePositionAt = (
  candles: ParsedCandle[],
  candleIndex: number,
  lookback: number,
): number | null => {
  if (candleIndex < 1 || candles.length <= candleIndex) return null;
  const start = Math.max(0, candleIndex - lookback + 1);
  const slice = candles.slice(start, candleIndex + 1);
  if (!slice.length) return null;
  const hi = Math.max(...slice.map((c) => c.high));
  const lo = Math.min(...slice.map((c) => c.low));
  const close = slice[slice.length - 1].close;
  const span = hi - lo;
  if (span <= 0) return 0.5;
  return (close - lo) / span;
};

export const evaluateOrderBlockSignals = (
  gate: OrderBlockEntryGate,
  candles: ParsedCandle[],
  candleIndex: number,
): OrderBlockSignals => {
  const empty: OrderBlockSignals = {
    supplyRejection: false,
    demandRejection: false,
    supplyLevel: null,
    demandLevel: null,
    rangePos: null,
    nearSupply: false,
    nearDemand: false,
  };
  if (candleIndex < 10 || candles.length <= candleIndex) return empty;

  const gateMode = gate.gateMode || 'orderblock';
  const rangeLookback = Math.max(12, Math.floor(gate.rangeLookbackBars ?? 48));
  const longBlockAbove = (gate.blockLongRangeAbove ?? 82) / 100;
  const shortBlockBelow = (gate.blockShortRangeBelow ?? 18) / 100;
  const rangePos = rangePositionAt(candles, candleIndex, rangeLookback);
  const nearSupply = rangePos != null && rangePos >= longBlockAbove;
  const nearDemand = rangePos != null && rangePos <= shortBlockBelow;

  if (gateMode === 'range') {
    return { ...empty, rangePos, nearSupply, nearDemand };
  }

  const wings = Math.max(1, Math.floor(gate.fractalWings ?? 2));
  const lookback = Math.max(12, Math.floor(gate.swingLookbackBars ?? 48));
  const tol = gate.eqTolerancePercent ?? 0.35;
  const sweep = gate.sweepMinPercent ?? 0.05;
  const emaPeriod = Math.max(5, Math.floor(gate.emaPeriod ?? 50));
  const panic = gate.panicMaxRangePercent ?? 2.5;

  const bar = candles[candleIndex];
  if (isPanicBar(bar, panic)) return empty;

  const start = Math.max(wings * 2, candleIndex - lookback);
  const swingHighs: number[] = [];
  const swingLows: number[] = [];
  for (let i = start; i < candleIndex - wings; i += 1) {
    if (isBearishFractalAt(candles, i, wings)) swingHighs.push(candles[i].high);
    if (isBullishFractalAt(candles, i, wings)) swingLows.push(candles[i].low);
  }

  const supplyLevel = clusterLiquidityLevel(swingHighs, tol, 'high');
  const demandLevel = clusterLiquidityLevel(swingLows, tol, 'low');
  const closes = candles.map((c) => c.close);
  const ema = emaAt(closes, candleIndex, emaPeriod);

  let supplyRejection = false;
  if (supplyLevel != null && supplyLevel > 0) {
    const swept = bar.high > supplyLevel * (1 + sweep / 100);
    const rejected = bar.close < supplyLevel;
    const emaOk = !gate.requireEmaAlign || (ema != null && bar.close > ema);
    supplyRejection = swept && rejected && emaOk;
  }

  let demandRejection = false;
  if (demandLevel != null && demandLevel > 0) {
    const swept = bar.low < demandLevel * (1 - sweep / 100);
    const rejected = bar.close > demandLevel;
    const emaOk = !gate.requireEmaAlign || (ema != null && bar.close < ema);
    demandRejection = swept && rejected && emaOk;
  }

  return {
    supplyRejection,
    demandRejection,
    supplyLevel,
    demandLevel,
    rangePos,
    nearSupply: nearSupply || supplyRejection,
    nearDemand: nearDemand || demandRejection,
  };
};

/** Returns true when entry is allowed (not blocked by liquidity fade). */
export const passesOrderBlockEntryGate = (
  gate: OrderBlockEntryGate,
  side: 'long' | 'short',
  candles: ParsedCandle[],
  candleIndex: number,
): boolean => {
  if (side !== 'long' && side !== 'short') return true;
  const signals = evaluateOrderBlockSignals(gate, candles, candleIndex);
  const mode = gate.gateMode || 'orderblock';
  if (side === 'long') {
    if (gate.blockLongAtSupply !== false && signals.supplyRejection) return false;
    if ((mode === 'range' || mode === 'combined') && signals.nearSupply) return false;
  }
  if (side === 'short') {
    if (gate.blockShortAtDemand !== false && signals.demandRejection) return false;
    if ((mode === 'range' || mode === 'combined') && signals.nearDemand) return false;
  }
  return true;
};

/**
 * Hamster-bot MRS 2 — limit mean-reversion around MA bands.
 *
 * Entry long:  limit at SMA(ohlc4, len_long)  * mult_long  (e.g. 0.94..0.96)
 * Entry short: limit at SMA(ohlc4, len_short) * mult_short (e.g. 1.04..1.06)
 * Exit long:   limit at SMA(ohlc4, close_len) * close_mult (~1.0)
 * Exit short:  same pattern for short close MA
 * Filter:      |entryBand - closeMa| / closeMa * 100 >= distanceFilterPct
 *
 * Levels for bar i use MA through bar i-1 (no lookahead; post-only placement).
 * Fill model: bar high/low touches limit → fill at limit price.
 *
 * Params storage:
 *   mrs2_config_json — full JSON (preferred for asymmetric lens)
 *   Fallback remap:
 *     price_channel_length → maLongLen (= maShortLen, maClose*Len)
 *     zscore_entry         → maLongMult
 *     zscore_exit          → maShortMult
 *     zscore_stop          → distanceFilterPct
 *     take_profit_percent  → unused (exits via close MA)
 */

import type { Strategy } from '../config/settings';

export type Mrs2Bar = {
  open: number;
  high: number;
  low: number;
  close: number;
  timeMs?: number;
};

export type Mrs2Params = {
  maLongLen: number;
  maLongMult: number;
  maShortLen: number;
  maShortMult: number;
  maCloseLongLen: number;
  maCloseLongMult: number;
  maCloseShortLen: number;
  maCloseShortMult: number;
  distanceFilterPct: number;
  slLongPct: number;
  slShortPct: number;
  longEnabled: boolean;
  shortEnabled: boolean;
};

export type Mrs2Levels = {
  entryLong: number;
  entryShort: number;
  exitLong: number;
  exitShort: number;
  maOpenLong: number;
  maOpenShort: number;
  maCloseLong: number;
  maCloseShort: number;
  distOkLong: boolean;
  distOkShort: boolean;
};

export type Mrs2PendingLimits = {
  long: number | null;
  short: number | null;
};

export type Mrs2BarAction = {
  /** Entry signal when flat (limit touch). */
  signal: 'long' | 'short' | 'none';
  /** Fill price for entry (limit). */
  fillPrice: number;
  /** Exit requested while in position. */
  exit: boolean;
  exitPrice: number;
  exitReason: string;
  levels: Mrs2Levels | null;
  current: number;
  /** Updated sticky entry limits (replace_open_order=false semantics). */
  pending: Mrs2PendingLimits | null;
};
export const MRS2_DEFAULTS: Mrs2Params = {
  maLongLen: 5,
  maLongMult: 0.95,
  maShortLen: 5,
  maShortMult: 1.05,
  maCloseLongLen: 5,
  maCloseLongMult: 1.0,
  maCloseShortLen: 5,
  maCloseShortMult: 1.0,
  distanceFilterPct: 0.3,
  slLongPct: 0,
  slShortPct: 0,
  longEnabled: true,
  shortEnabled: true,
};

export const isMrs2StrategyType = (strategyType: string): boolean => {
  const t = String(strategyType || '').trim();
  return t === 'MRS2' || t === 'mrs2' || t === 'mrs2_ma_limit';
};

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const boolFlag = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  const s = String(v).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return fallback;
};

const ohlc4 = (b: Mrs2Bar): number => (b.open + b.high + b.low + b.close) / 4;

/** SMA of ohlc4 ending at `endIndex` inclusive; NaN if insufficient history. */
export const smaOhlc4At = (bars: Mrs2Bar[], endIndex: number, period: number): number => {
  const len = Math.max(1, Math.floor(period));
  if (endIndex < len - 1 || endIndex < 0 || endIndex >= bars.length) return NaN;
  let sum = 0;
  for (let i = endIndex - len + 1; i <= endIndex; i += 1) {
    sum += ohlc4(bars[i]);
  }
  return sum / len;
};

const parseConfigJson = (raw: unknown): Partial<Mrs2Params> | null => {
  if (raw == null) return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '{}') return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  return {
    maLongLen: obj.maLongLen ?? obj.ma_long_len ?? obj.ma_long?.len,
    maLongMult: obj.maLongMult ?? obj.ma_long_mult ?? obj.ma_long?.multiplier,
    maShortLen: obj.maShortLen ?? obj.ma_short_len ?? obj.ma_short?.len,
    maShortMult: obj.maShortMult ?? obj.ma_short_mult ?? obj.ma_short?.multiplier,
    maCloseLongLen: obj.maCloseLongLen ?? obj.ma_close_long_len ?? obj.ma_close_long?.len,
    maCloseLongMult: obj.maCloseLongMult ?? obj.ma_close_long_mult ?? obj.ma_close_long?.multiplier,
    maCloseShortLen: obj.maCloseShortLen ?? obj.ma_close_short_len ?? obj.ma_close_short?.len,
    maCloseShortMult: obj.maCloseShortMult ?? obj.ma_close_short_mult ?? obj.ma_close_short?.multiplier,
    distanceFilterPct: obj.distanceFilterPct ?? obj.distance_filter ?? obj.mrs_dist,
    slLongPct: obj.slLongPct ?? obj.sl_long ?? obj.slLong,
    slShortPct: obj.slShortPct ?? obj.sl_short ?? obj.slShort,
    longEnabled: obj.longEnabled,
    shortEnabled: obj.shortEnabled,
  };
};

export const extractMrs2Params = (strategy: Partial<Strategy> & { mrs2_config_json?: string | null }): Mrs2Params => {
  const fromJson = parseConfigJson((strategy as any).mrs2_config_json);
  const d = MRS2_DEFAULTS;
  const channel = Math.max(2, Math.floor(num(strategy.price_channel_length, d.maLongLen)));
  return {
    maLongLen: Math.max(2, Math.floor(num(fromJson?.maLongLen, channel))),
    maLongMult: num(fromJson?.maLongMult, num(strategy.zscore_entry, d.maLongMult)),
    maShortLen: Math.max(2, Math.floor(num(fromJson?.maShortLen, channel))),
    maShortMult: num(fromJson?.maShortMult, num(strategy.zscore_exit, d.maShortMult)),
    maCloseLongLen: Math.max(2, Math.floor(num(fromJson?.maCloseLongLen, channel))),
    maCloseLongMult: num(fromJson?.maCloseLongMult, d.maCloseLongMult),
    maCloseShortLen: Math.max(2, Math.floor(num(fromJson?.maCloseShortLen, channel))),
    maCloseShortMult: num(fromJson?.maCloseShortMult, d.maCloseShortMult),
    distanceFilterPct: Math.max(0, num(fromJson?.distanceFilterPct, num(strategy.zscore_stop, d.distanceFilterPct))),
    slLongPct: Math.max(0, num(fromJson?.slLongPct, 0)),
    slShortPct: Math.max(0, num(fromJson?.slShortPct, 0)),
    longEnabled: boolFlag(fromJson?.longEnabled, boolFlag(strategy.long_enabled, true)),
    shortEnabled: boolFlag(fromJson?.shortEnabled, boolFlag(strategy.short_enabled, true)),
  };
};

/**
 * Parse sticky pending entry-limit levels persisted in `strategies.mrs2_pending_json`.
 * Must be passed as the `pendingIn` arg to `evaluateMrs2Bar` every live cycle — otherwise
 * multi-bar resting limits are forgotten (see ORDERS_AND_SYNTH_MRS.md §2 code-gap #1).
 */
export const parseMrs2PendingLimits = (raw: unknown): Mrs2PendingLimits | null => {
  if (raw == null) return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '{}') return null;
    try {
      obj = JSON.parse(s);
    } catch {
      return null;
    }
  }
  if (!obj || typeof obj !== 'object') return null;
  const long = num(obj.long, NaN);
  const short = num(obj.short, NaN);
  const parsed: Mrs2PendingLimits = {
    long: Number.isFinite(long) && long > 0 ? long : null,
    short: Number.isFinite(short) && short > 0 ? short : null,
  };
  return (parsed.long == null && parsed.short == null) ? null : parsed;
};

/** Serialize sticky pending entry-limit levels for persistence in `strategies.mrs2_pending_json`. */
export const serializeMrs2PendingLimits = (pending: Mrs2PendingLimits | null): string => JSON.stringify({
  long: pending?.long ?? null,
  short: pending?.short ?? null,
});

export const mrs2WarmupBars = (params: Mrs2Params): number => (
  Math.max(
    params.maLongLen,
    params.maShortLen,
    params.maCloseLongLen,
    params.maCloseShortLen,
  ) + 2
);

/** Levels for evaluating bar `index` use MA through `index - 1`. */
export const computeMrs2LevelsAtIndex = (
  bars: Mrs2Bar[],
  index: number,
  params: Mrs2Params,
): Mrs2Levels | null => {
  const src = index - 1;
  if (src < 0) return null;
  const maOpenLong = smaOhlc4At(bars, src, params.maLongLen);
  const maOpenShort = smaOhlc4At(bars, src, params.maShortLen);
  const maCloseLong = smaOhlc4At(bars, src, params.maCloseLongLen);
  const maCloseShort = smaOhlc4At(bars, src, params.maCloseShortLen);
  if (![maOpenLong, maOpenShort, maCloseLong, maCloseShort].every((v) => Number.isFinite(v) && v > 0)) {
    return null;
  }
  const entryLong = maOpenLong * params.maLongMult;
  const entryShort = maOpenShort * params.maShortMult;
  const exitLong = maCloseLong * params.maCloseLongMult;
  const exitShort = maCloseShort * params.maCloseShortMult;
  const distLongPct = Math.abs(entryLong - exitLong) / exitLong * 100;
  const distShortPct = Math.abs(entryShort - exitShort) / exitShort * 100;
  return {
    entryLong,
    entryShort,
    exitLong,
    exitShort,
    maOpenLong,
    maOpenShort,
    maCloseLong,
    maCloseShort,
    distOkLong: distLongPct >= params.distanceFilterPct,
    distOkShort: distShortPct >= params.distanceFilterPct,
  };
};

/**
 * Evaluate one bar for MRS2 limit MR.
 * - Entry limits are sticky (hamster replace_open_order=false): place once while flat,
 *   keep until fill/cancel; do not chase MA each bar. Null sides may re-place.
 * - post_only entries: skip/cancel if open already marketable; fill at limit on touch.
 * - Exit limits track close-MA each bar (levels from prior bar).
 * - Same-bar TP+SL: SL first (conservative).
 */
export const evaluateMrs2Bar = (
  bars: Mrs2Bar[],
  index: number,
  params: Mrs2Params,
  positionSide: 'flat' | 'long' | 'short',
  entryPrice: number | null,
  pendingIn: Mrs2PendingLimits | null = null,
): Mrs2BarAction => {
  const bar = bars[index];
  const current = bar?.close ?? 0;
  const levels = computeMrs2LevelsAtIndex(bars, index, params);
  const empty: Mrs2BarAction = {
    signal: 'none',
    fillPrice: current,
    exit: false,
    exitPrice: current,
    exitReason: '',
    levels,
    current,
    pending: pendingIn,
  };
  if (!bar) return empty;

  /** Limit is touchable only if price traded through it inside the bar range. */
  const touched = (limit: number): boolean => (
    Number.isFinite(limit) && limit > 0 && bar.low <= limit && limit <= bar.high
  );

  if (positionSide === 'long' && entryPrice && entryPrice > 0) {
    if (!levels) return { ...empty, pending: null };
    if (params.slLongPct > 0) {
      const sl = entryPrice * (1 - params.slLongPct / 100);
      if (touched(sl)) {
        return { ...empty, exit: true, exitPrice: sl, exitReason: 'mrs2_sl_long', pending: null };
      }
      if (bar.high < sl) {
        // gapped down through SL
        return { ...empty, exit: true, exitPrice: bar.open, exitReason: 'mrs2_sl_long', pending: null };
      }
    }
    // Sell-limit exit at close MA
    if (touched(levels.exitLong)) {
      return {
        ...empty,
        exit: true,
        exitPrice: levels.exitLong,
        exitReason: 'mrs2_ma_exit_long',
        pending: null,
      };
    }
    if (bar.open >= levels.exitLong) {
      return {
        ...empty,
        exit: true,
        exitPrice: bar.open,
        exitReason: 'mrs2_ma_exit_long',
        pending: null,
      };
    }
    return { ...empty, pending: null };
  }

  if (positionSide === 'short' && entryPrice && entryPrice > 0) {
    if (!levels) return { ...empty, pending: null };
    if (params.slShortPct > 0) {
      const sl = entryPrice * (1 + params.slShortPct / 100);
      if (touched(sl)) {
        return { ...empty, exit: true, exitPrice: sl, exitReason: 'mrs2_sl_short', pending: null };
      }
      if (bar.low > sl) {
        // gapped up through SL
        return { ...empty, exit: true, exitPrice: bar.open, exitReason: 'mrs2_sl_short', pending: null };
      }
    }
    // Buy-limit exit at close MA: touch inside bar or gap-through below
    if (touched(levels.exitShort)) {
      return {
        ...empty,
        exit: true,
        exitPrice: levels.exitShort,
        exitReason: 'mrs2_ma_exit_short',
        pending: null,
      };
    }
    if (bar.open <= levels.exitShort) {
      return {
        ...empty,
        exit: true,
        exitPrice: bar.open,
        exitReason: 'mrs2_ma_exit_short',
        pending: null,
      };
    }
    return { ...empty, pending: null };
  }

  // Flat → sticky entry limits (replace_open_order=false).
  // Levels are from prior bar (no lookahead). Place missing sides at bar open if
  // post_only allows (not already marketable), then allow same-bar touch fills.
  const normalizePending = (p: Mrs2PendingLimits | null): Mrs2PendingLimits | null => {
    if (!p) return null;
    if (p.long == null && p.short == null) return null;
    return p;
  };

  const pending: Mrs2PendingLimits = {
    long: pendingIn?.long ?? null,
    short: pendingIn?.short ?? null,
  };

  // post_only: cancel resting side if open already crossed it (would take).
  if (pending.long != null && bar.open < pending.long) pending.long = null;
  if (pending.short != null && bar.open > pending.short) pending.short = null;

  // Top up null sides from current levels (sticky price once placed; refresh only if missing).
  if (levels) {
    if (
      pending.long == null
      && params.longEnabled
      && levels.distOkLong
      && bar.open >= levels.entryLong
    ) {
      pending.long = levels.entryLong;
    }
    if (
      pending.short == null
      && params.shortEnabled
      && levels.distOkShort
      && bar.open <= levels.entryShort
    ) {
      pending.short = levels.entryShort;
    }
  }

  const longPx = (
    pending.long != null
    && bar.open >= pending.long
    && bar.low <= pending.long
    && pending.long <= bar.high
  ) ? pending.long : null;
  const shortPx = (
    pending.short != null
    && bar.open <= pending.short
    && bar.low <= pending.short
    && pending.short <= bar.high
  ) ? pending.short : null;

  if (longPx != null && shortPx != null) {
    const mid = (longPx + shortPx) / 2;
    if (bar.open <= mid) {
      return { ...empty, signal: 'long', fillPrice: longPx, pending: null };
    }
    return { ...empty, signal: 'short', fillPrice: shortPx, pending: null };
  }
  if (longPx != null) {
    return { ...empty, signal: 'long', fillPrice: longPx, pending: null };
  }
  if (shortPx != null) {
    return { ...empty, signal: 'short', fillPrice: shortPx, pending: null };
  }
  return { ...empty, pending: normalizePending(pending) };
};
/** Serialize hamster-style params for strategies.mrs2_config_json. */
export const buildMrs2ConfigJson = (p: Partial<Mrs2Params>): string => {
  const full: Mrs2Params = { ...MRS2_DEFAULTS, ...p };
  return JSON.stringify({
    maLongLen: full.maLongLen,
    maLongMult: full.maLongMult,
    maShortLen: full.maShortLen,
    maShortMult: full.maShortMult,
    maCloseLongLen: full.maCloseLongLen,
    maCloseLongMult: full.maCloseLongMult,
    maCloseShortLen: full.maCloseShortLen,
    maCloseShortMult: full.maCloseShortMult,
    distanceFilterPct: full.distanceFilterPct,
    slLongPct: full.slLongPct,
    slShortPct: full.slShortPct,
  });
};

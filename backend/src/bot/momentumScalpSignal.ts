/**
 * TV EMA crossover + ADX/DI trend filter (momentum_scalp_tv).
 *
 * Strategy field mapping (no extra DB columns):
 *   price_channel_length → emaFastPeriod (default 8)
 *   zscore_entry         → emaSlowPeriod (default 21)
 *   zscore_exit          → adxMin (default 20)
 *   take_profit_percent  → tpPercent (default 2)
 *   zscore_stop          → slPercent (default 1.2)
 */

import type { Strategy } from '../config/settings';

export type MomentumScalpBar = {
  open: number;
  high: number;
  low: number;
  close: number;
  timeMs?: number;
};

export type MomentumScalpParams = {
  emaFastPeriod: number;
  emaSlowPeriod: number;
  adxPeriod: number;
  adxMin: number;
  tpPercent: number;
  slPercent: number;
  exitOnOppositeCross: boolean;
  longEnabled: boolean;
  shortEnabled: boolean;
};

export type MomentumScalpSignal = {
  signal: 'long' | 'short' | 'none';
  current: number;
  adx: number;
  plusDi: number;
  minusDi: number;
  /** Opposite EMA cross while in position → exit hint */
  oppositeCross: boolean;
};

export type MomentumScalpIndicatorSeries = {
  emaFast: number[];
  emaSlow: number[];
  adx: number[];
  plusDi: number[];
  minusDi: number[];
  warmup: number;
};

export const MOMENTUM_SCALP_TV_DEFAULTS: MomentumScalpParams = {
  emaFastPeriod: 8,
  emaSlowPeriod: 21,
  adxPeriod: 14,
  adxMin: 20,
  tpPercent: 2,
  slPercent: 1.2,
  exitOnOppositeCross: true,
  longEnabled: true,
  shortEnabled: true,
};

export const isMomentumScalpStrategyType = (strategyType: string): boolean => (
  String(strategyType || '').trim() === 'momentum_scalp_tv'
);

const num = (v: unknown, fallback: number): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const boolFlag = (v: unknown, fallback: boolean): boolean => {
  if (v === undefined || v === null) return fallback;
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  return String(v).trim() !== '0' && String(v).trim().toLowerCase() !== 'false';
};

export const extractMomentumScalpParams = (strategy: Partial<Strategy>): MomentumScalpParams => ({
  emaFastPeriod: Math.max(2, Math.floor(num(strategy.price_channel_length, MOMENTUM_SCALP_TV_DEFAULTS.emaFastPeriod))),
  emaSlowPeriod: Math.max(3, Math.floor(num(strategy.zscore_entry, MOMENTUM_SCALP_TV_DEFAULTS.emaSlowPeriod))),
  adxPeriod: MOMENTUM_SCALP_TV_DEFAULTS.adxPeriod,
  adxMin: Math.max(5, num(strategy.zscore_exit, MOMENTUM_SCALP_TV_DEFAULTS.adxMin)),
  tpPercent: Math.max(0.1, num(strategy.take_profit_percent, MOMENTUM_SCALP_TV_DEFAULTS.tpPercent)),
  slPercent: Math.max(0.1, num(strategy.zscore_stop, MOMENTUM_SCALP_TV_DEFAULTS.slPercent)),
  exitOnOppositeCross: MOMENTUM_SCALP_TV_DEFAULTS.exitOnOppositeCross,
  longEnabled: boolFlag(strategy.long_enabled, true),
  shortEnabled: boolFlag(strategy.short_enabled, true),
});

const emaSeries = (values: number[], period: number): number[] => {
  const out = new Array<number>(values.length).fill(NaN);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let sum = 0;
  for (let i = 0; i < period; i += 1) sum += values[i];
  out[period - 1] = sum / period;
  for (let i = period; i < values.length; i += 1) {
    out[i] = values[i] * k + out[i - 1] * (1 - k);
  }
  return out;
};

const wilderSeries = (seed: number, values: number[], period: number, startIdx: number): number[] => {
  const out = new Array<number>(values.length).fill(NaN);
  if (startIdx + period > values.length) return out;
  let sum = seed;
  for (let i = startIdx; i < startIdx + period; i += 1) sum += values[i];
  let prev = sum / period;
  out[startIdx + period - 1] = prev;
  for (let i = startIdx + period; i < values.length; i += 1) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
};

export const buildMomentumScalpIndicatorSeries = (
  bars: MomentumScalpBar[],
  params: MomentumScalpParams,
): MomentumScalpIndicatorSeries => {
  const closes = bars.map((b) => b.close);
  const emaFast = emaSeries(closes, params.emaFastPeriod);
  const emaSlow = emaSeries(closes, params.emaSlowPeriod);
  const n = bars.length;
  const adx = new Array<number>(n).fill(NaN);
  const plusDi = new Array<number>(n).fill(NaN);
  const minusDi = new Array<number>(n).fill(NaN);
  const period = params.adxPeriod;

  if (n >= period * 2) {
    const tr: number[] = new Array(n).fill(0);
    const plusDm: number[] = new Array(n).fill(0);
    const minusDm: number[] = new Array(n).fill(0);
    for (let i = 1; i < n; i += 1) {
      const c = bars[i];
      const p = bars[i - 1];
      const up = c.high - p.high;
      const down = p.low - c.low;
      plusDm[i] = up > down && up > 0 ? up : 0;
      minusDm[i] = down > up && down > 0 ? down : 0;
      tr[i] = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
    }
    const trSm = wilderSeries(tr[1], tr.slice(1), period, 0);
    const plusSm = wilderSeries(plusDm[1], plusDm.slice(1), period, 0);
    const minusSm = wilderSeries(minusDm[1], minusDm.slice(1), period, 0);
    const dx: number[] = new Array(n).fill(NaN);
    for (let i = 0; i < n; i += 1) {
      const trv = trSm[i];
      if (!Number.isFinite(trv) || trv <= 0) continue;
      const pdi = (100 * plusSm[i]) / trv;
      const mdi = (100 * minusSm[i]) / trv;
      plusDi[i] = pdi;
      minusDi[i] = mdi;
      const denom = pdi + mdi;
      dx[i] = denom > 0 ? (100 * Math.abs(pdi - mdi)) / denom : 0;
    }
    const dxVals = dx.map((v) => (Number.isFinite(v) ? v : 0));
    const adxSm = wilderSeries(dxVals[period], dxVals.slice(period), period, 0);
    for (let i = 0; i < n; i += 1) {
      if (Number.isFinite(adxSm[i])) adx[i] = adxSm[i];
    }
  }

  return {
    emaFast,
    emaSlow,
    adx,
    plusDi,
    minusDi,
    warmup: Math.max(params.emaSlowPeriod, params.adxPeriod * 2) + 2,
  };
};

export const computeMomentumScalpSignalAtIndex = (
  bars: MomentumScalpBar[],
  index: number,
  params: MomentumScalpParams,
  series?: MomentumScalpIndicatorSeries,
  positionSide?: 'long' | 'short' | 'flat',
): MomentumScalpSignal => {
  const ind = series ?? buildMomentumScalpIndicatorSeries(bars, params);
  const none: MomentumScalpSignal = {
    signal: 'none',
    current: bars[index]?.close ?? 0,
    adx: NaN,
    plusDi: NaN,
    minusDi: NaN,
    oppositeCross: false,
  };
  if (index < ind.warmup || index >= bars.length) return none;

  const ef = ind.emaFast[index];
  const es = ind.emaSlow[index];
  const efP = ind.emaFast[index - 1];
  const esP = ind.emaSlow[index - 1];
  const adxVal = ind.adx[index];
  const pdi = ind.plusDi[index];
  const mdi = ind.minusDi[index];
  if (![ef, es, efP, esP].every(Number.isFinite) || !Number.isFinite(adxVal)) return none;

  const bullCross = efP <= esP && ef > es;
  const bearCross = efP >= esP && ef < es;
  const trending = adxVal >= params.adxMin;
  const oppositeCross =
    (positionSide === 'short' && bullCross) ||
    (positionSide === 'long' && bearCross);

  let signal: 'long' | 'short' | 'none' = 'none';
  if (params.longEnabled && bullCross && trending && pdi > mdi) signal = 'long';
  else if (params.shortEnabled && bearCross && trending && mdi > pdi) signal = 'short';

  return {
    signal,
    current: bars[index].close,
    adx: adxVal,
    plusDi: pdi,
    minusDi: mdi,
    oppositeCross,
  };
};

export const momentumScalpTpSlPrices = (
  side: 'long' | 'short',
  entryPrice: number,
  params: MomentumScalpParams,
): { tp: number; sl: number } => {
  if (side === 'long') {
    return {
      tp: entryPrice * (1 + params.tpPercent / 100),
      sl: entryPrice * (1 - params.slPercent / 100),
    };
  }
  return {
    tp: entryPrice * (1 - params.tpPercent / 100),
    sl: entryPrice * (1 + params.slPercent / 100),
  };
};

/**
 * CT_Fractal — contrarian synth: stat_arb z-score + HiDeep deep + confirmed fractal.
 * All three must agree for entry; exits use z mean-revert/stop and HiDeep RSI extremes.
 */

export type CtFractalBar = {
  open: number;
  high: number;
  low: number;
  close: number;
};

export type CtFractalSignal = {
  signal: 'long' | 'short' | 'none';
  current: number;
  /** Z-score of ratio vs rolling window. */
  zScore: number;
  /** HiDeep fast RSI (stored separately from z for dual exits). */
  fastRsi: number;
  /** Rolling mean (z anchor) / HiDeep MAC center. */
  donchianCenter: number;
};

export const CT_FRACTAL_DEFAULTS = {
  fractalWings: 2,
  fractalLookback: 12,
  hideepRsiPeriod: 2,
  hideepSma1Period: 100,
  hideepRsiOversold: 10,
  hideepRsiOverbought: 90,
};

const mean = (values: number[]): number => {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
};

const stddev = (values: number[]): number => {
  if (values.length === 0) return 0;
  const avg = mean(values);
  const variance = values.reduce((sum, v) => {
    const d = v - avg;
    return sum + d * d;
  }, 0) / values.length;
  return Math.sqrt(Math.max(0, variance));
};

const isBearishFractalAt = (bars: CtFractalBar[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= bars.length) return false;
  const pivotHigh = bars[index].high;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (bars[index - offset].high >= pivotHigh) return false;
    if (bars[index + offset].high >= pivotHigh) return false;
  }
  return true;
};

const isBullishFractalAt = (bars: CtFractalBar[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= bars.length) return false;
  const pivotLow = bars[index].low;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (bars[index - offset].low <= pivotLow) return false;
    if (bars[index + offset].low <= pivotLow) return false;
  }
  return true;
};

const hasConfirmedBearishFractal = (bars: CtFractalBar[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBearishFractalAt(bars, pivotIndex, wings);
};

const hasConfirmedBullishFractal = (bars: CtFractalBar[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBullishFractalAt(bars, pivotIndex, wings);
};

export const hasRecentConfirmedFractal = (
  bars: CtFractalBar[],
  candleIndex: number,
  wings: number,
  lookbackBars: number,
  kind: 'bullish' | 'bearish',
): boolean => {
  const start = Math.max(wings * 2, candleIndex - lookbackBars);
  for (let idx = candleIndex; idx >= start; idx -= 1) {
    if (kind === 'bullish' && hasConfirmedBullishFractal(bars, idx, wings)) return true;
    if (kind === 'bearish' && hasConfirmedBearishFractal(bars, idx, wings)) return true;
  }
  return false;
};

const computeFastRsi = (bars: CtFractalBar[], index: number, period: number): number => {
  const rsiPeriod = Math.max(2, Math.floor(period));
  if (index < rsiPeriod) return 50;
  let avgGain = 0;
  let avgLoss = 0;
  for (let i = index - rsiPeriod + 1; i <= index; i += 1) {
    const diff = bars[i].close - bars[i - 1].close;
    if (diff > 0) avgGain += diff;
    else avgLoss += Math.abs(diff);
  }
  const n = rsiPeriod;
  avgGain /= n;
  avgLoss /= n;
  if (avgLoss <= 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - (100 / (1 + rs));
};

const computeHideepMomentum = (
  bars: CtFractalBar[],
  index: number,
  mac1: number,
  sma1Period: number,
): { mac1Val: number; hasMomentum: boolean } => {
  const macLen = Math.max(2, Math.floor(mac1));
  const smaLen = Math.max(20, Math.floor(sma1Period));
  const mac1Window = bars.slice(index - macLen + 1, index + 1).map((c) => c.close);
  const mac1Val = mean(mac1Window);
  const len1 = Math.abs(bars[index].close - mac1Val);

  const deviations: number[] = [];
  const start = Math.max(macLen - 1, index - smaLen - macLen + 2);
  for (let i = start; i <= index; i += 1) {
    if (i < macLen - 1) continue;
    const slice = bars.slice(i - macLen + 1, i + 1);
    const sliceMac = mean(slice.map((c) => c.close));
    deviations.push(Math.abs(bars[i].close - sliceMac));
  }
  const sma1Val = deviations.length > 0 ? mean(deviations) : 0;
  return { mac1Val, hasMomentum: len1 > sma1Val && sma1Val > 0 };
};

export const isCtFractalStrategyType = (strategyType: string): boolean => (
  strategyType === 'CT_Fractal'
);

export const computeCtFractalSignalAtIndex = (
  bars: CtFractalBar[],
  index: number,
  lookbackLength: number,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean,
  options?: {
    fractalWings?: number;
    fractalLookback?: number;
    hideepRsiPeriod?: number;
    hideepSma1Period?: number;
    hideepMac1?: number;
  },
): CtFractalSignal => {
  const length = Math.max(8, Math.floor(lookbackLength));
  const entryZ = Math.max(0.5, zscoreEntry);
  const wings = Math.max(1, Math.floor(options?.fractalWings ?? CT_FRACTAL_DEFAULTS.fractalWings));
  const lookback = Math.max(4, Math.floor(options?.fractalLookback ?? CT_FRACTAL_DEFAULTS.fractalLookback));
  const rsiPeriod = Math.max(2, Math.floor(options?.hideepRsiPeriod ?? CT_FRACTAL_DEFAULTS.hideepRsiPeriod));
  const sma1Period = Math.max(20, Math.floor(options?.hideepSma1Period ?? CT_FRACTAL_DEFAULTS.hideepSma1Period));
  const mac1 = Math.max(4, Math.floor(options?.hideepMac1 ?? Math.min(length, 15)));

  const needed = Math.max(length + 1, mac1 + sma1Period, rsiPeriod + 2);
  if (index < needed || index >= bars.length) {
    throw new Error(`CT_Fractal: not enough candles at index ${index}, need ${needed}`);
  }

  const current = bars[index];
  const window = bars.slice(index - length, index).map((c) => c.close);
  const avg = mean(window);
  const sigma = stddev(window);
  const zScore = !Number.isFinite(sigma) || sigma <= 1e-12 ? 0 : (current.close - avg) / sigma;

  const fastRsi = computeFastRsi(bars, index, rsiPeriod);
  const { mac1Val, hasMomentum } = computeHideepMomentum(bars, index, mac1, sma1Period);
  const isBearCandle = current.close < current.open;
  const isBullCandle = current.close > current.open;

  const hideepLong = isBearCandle && hasMomentum && fastRsi < CT_FRACTAL_DEFAULTS.hideepRsiOversold;
  const hideepShort = isBullCandle && hasMomentum && fastRsi > CT_FRACTAL_DEFAULTS.hideepRsiOverbought;
  const fractalLong = hasRecentConfirmedFractal(bars, index, wings, lookback, 'bullish');
  const fractalShort = hasRecentConfirmedFractal(bars, index, wings, lookback, 'bearish');

  const statLong = zScore <= -entryZ;
  const statShort = zScore >= entryZ;

  if (longEnabled && statLong && hideepLong && fractalLong) {
    return { signal: 'long', current: current.close, zScore, fastRsi, donchianCenter: avg };
  }
  if (shortEnabled && statShort && hideepShort && fractalShort) {
    return { signal: 'short', current: current.close, zScore, fastRsi, donchianCenter: avg };
  }

  return { signal: 'none', current: current.close, zScore, fastRsi, donchianCenter: avg };
};

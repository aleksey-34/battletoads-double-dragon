/**
 * ZZ pivot levels: ZZ_Fast (slow = fast×3) and ZZ_Instance (slow = fast×2).
 * Levels update on confirmed pivot: fast extreme aligns with slow extreme, then rolls.
 */

export type ZzPivotVariant = 'fast' | 'instance';

export type ZzPivotLevels = {
  levelLong: number;
  levelShort: number;
};

export type ZzPivotBar = {
  high: number;
  low: number;
  close: number;
};

const slowMultiplier = (variant: ZzPivotVariant): number => (variant === 'fast' ? 3 : 2);

const windowHigh = (bars: ZzPivotBar[], endIndex: number, length: number): number => {
  const start = Math.max(0, endIndex - length + 1);
  let maxVal = -Infinity;
  for (let i = start; i <= endIndex; i += 1) {
    maxVal = Math.max(maxVal, bars[i].high);
  }
  return maxVal;
};

const windowLow = (bars: ZzPivotBar[], endIndex: number, length: number): number => {
  const start = Math.max(0, endIndex - length + 1);
  let minVal = Infinity;
  for (let i = start; i <= endIndex; i += 1) {
    minVal = Math.min(minVal, bars[i].low);
  }
  return minVal;
};

export const buildZzPivotLevelSeries = (
  bars: ZzPivotBar[],
  fastLen: number,
  variant: ZzPivotVariant,
): ZzPivotLevels[] => {
  const fast = Math.max(2, Math.floor(fastLen));
  const slow = Math.max(fast + 1, Math.round(fast * slowMultiplier(variant)));
  const series: ZzPivotLevels[] = [];
  let levelLong = 0;
  let levelShort = 0;

  for (let i = 0; i < bars.length; i += 1) {
    if (i >= slow) {
      const fasth = windowHigh(bars, i, fast);
      const slowh = windowHigh(bars, i, slow);
      const fastl = windowLow(bars, i, fast);
      const slowl = windowLow(bars, i, slow);
      const prevFasth = windowHigh(bars, i - 1, fast);
      const prevSlowh = windowHigh(bars, i - 1, slow);
      const prevFastl = windowLow(bars, i - 1, fast);
      const prevSlowl = windowLow(bars, i - 1, slow);

      if (prevFasth === prevSlowh && fasth < prevFasth) {
        levelLong = prevFasth;
      }
      if (prevFastl === prevSlowl && fastl > prevFastl) {
        levelShort = prevFastl;
      }
    }

    const fallback = bars[i].close;
    series.push({
      levelLong: levelLong > 0 ? levelLong : fallback,
      levelShort: levelShort > 0 ? levelShort : fallback,
    });
  }

  return series;
};

export const computeZzPivotEntrySignal = (
  bar: ZzPivotBar,
  levels: ZzPivotLevels,
  longEnabled: boolean,
  shortEnabled: boolean,
): 'long' | 'short' | 'none' => {
  const { levelLong, levelShort } = levels;
  if (longEnabled && levelLong > 0 && bar.high >= levelLong) {
    return 'long';
  }
  if (shortEnabled && levelShort > 0 && bar.low <= levelShort) {
    return 'short';
  }
  return 'none';
};

export const isZzPivotStrategyType = (strategyType: string): boolean => (
  strategyType === 'ZZ_Fast' || strategyType === 'ZZ_Instance'
);

/** Legacy sweep/DB aliases → canonical types (no hamster naming). */
export const normalizeZzPivotStrategyType = (strategyType: string): string => {
  const token = String(strategyType || '').trim();
  if (token === 'zz_hamster_zz6' || token === 'ZZ_HAMSTER_ZZ6') {
    return 'ZZ_Fast';
  }
  if (token === 'zz_hamster_zz2' || token === 'ZZ_HAMSTER_ZZ2') {
    return 'ZZ_Instance';
  }
  return token;
};

export const zzPivotVariantFromType = (strategyType: string): ZzPivotVariant => {
  const normalized = normalizeZzPivotStrategyType(strategyType);
  return normalized === 'ZZ_Instance' ? 'instance' : 'fast';
};

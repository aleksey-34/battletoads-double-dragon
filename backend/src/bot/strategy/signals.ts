/**
 * Live signal computation (extracted from bot/strategy.ts).
 */
import { Strategy, StrategyType } from '../../config/settings';
import {
  buildZzPivotLevelSeries,
  computeZzPivotEntrySignal,
  isZzPivotStrategyType,
  resolveZzBreakMode,
  zzPivotVariantFromType,
} from '../zzPivotLevels';
import { computeCtFractalSignalAtIndex, isCtFractalStrategyType } from '../ctFractalSignal';
import {
  computeMomentumScalpSignalAtIndex,
  extractMomentumScalpParams,
  isMomentumScalpStrategyType,
} from '../momentumScalpSignal';
import {
  evaluateMrs2Bar,
  extractMrs2Params,
  isMrs2StrategyType,
} from '../mrs2Signal';
import type { ComputedSignal, ParsedSyntheticCandle, StrategySignal } from './types';

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

export const computeDonchianSignal = (
  candles: ParsedSyntheticCandle[],
  length: number,
  detectionSource: 'wick' | 'close',
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (candles.length < length + 1) {
    throw new Error(`Not enough candles for Donchian channel: need ${length + 1}, got ${candles.length}`);
  }

  const current = candles[candles.length - 1];
  const window = candles.slice(candles.length - 1 - length, candles.length - 1);

  if (window.length === 0) {
    throw new Error('Donchian window is empty');
  }

  const highs = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.high);
  const lows = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.low);

  const donchianHigh = Math.max(...highs);
  const donchianLow = Math.min(...lows);
  const donchianCenter = (donchianHigh + donchianLow) / 2;

  const longBreakout = detectionSource === 'close' ? current.close >= donchianHigh : current.high >= donchianHigh;
  const shortBreakout = detectionSource === 'close' ? current.close <= donchianLow : current.low <= donchianLow;

  if (longEnabled && longBreakout) {
    return {
      signal: 'long',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: null,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: null,
    };
  }

  return {
    signal: 'none',
    currentRatio: current.close,
    donchianHigh,
    donchianLow,
    donchianCenter,
    zScore: null,
  };
};

export const computeStatArbSignal = (
  candles: ParsedSyntheticCandle[],
  lookbackLength: number,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (candles.length < lookbackLength + 1) {
    throw new Error(`Not enough candles for z-score window: need ${lookbackLength + 1}, got ${candles.length}`);
  }

  const current = candles[candles.length - 1];
  const window = candles.slice(candles.length - 1 - lookbackLength, candles.length - 1);
  const series = window.map((item) => item.close);

  const avg = mean(series);
  const sigma = stddev(series);
  const currentRatio = current.close;

  const donchianCenter = avg;
  const donchianHigh = avg + sigma;
  const donchianLow = avg - sigma;

  if (!Number.isFinite(sigma) || sigma <= 1e-12) {
    return {
      signal: 'none',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore: 0,
    };
  }

  const zScore = (currentRatio - avg) / sigma;

  if (shortEnabled && zScore >= zscoreEntry) {
    return {
      signal: 'short',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore,
    };
  }

  if (longEnabled && zScore <= -zscoreEntry) {
    return {
      signal: 'long',
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
      zScore,
    };
  }

  return {
    signal: 'none',
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    zScore,
  };
};

export const computeZzPivotSignal = (
  candles: ParsedSyntheticCandle[],
  length: number,
  strategyType: StrategyType,
  longEnabled: boolean,
  shortEnabled: boolean,
  breakMode: 'wick' | 'close' = 'wick',
): ComputedSignal => {
  const fastLen = Math.max(2, Math.floor(length));
  const variant = zzPivotVariantFromType(strategyType);
  const levelsSeries = buildZzPivotLevelSeries(candles, fastLen, variant);
  const index = candles.length - 1;
  const current = candles[index];
  const levels = levelsSeries[index];
  const entry = computeZzPivotEntrySignal(current, levels, longEnabled, shortEnabled, breakMode);
  const center = (levels.levelLong + levels.levelShort) / 2;
  return {
    signal: entry,
    currentRatio: current.close,
    donchianHigh: levels.levelLong,
    donchianLow: levels.levelShort,
    donchianCenter: center,
    zScore: null,
  };
};

export const computeCtFractalSignal = (
  candles: ParsedSyntheticCandle[],
  length: number,
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean,
): ComputedSignal => {
  const index = candles.length - 1;
  const ct = computeCtFractalSignalAtIndex(
    candles,
    index,
    length,
    zscoreEntry,
    longEnabled,
    shortEnabled,
  );
  const sigma = Math.abs(ct.zScore) > 0 ? Math.abs(ct.current - ct.donchianCenter) / Math.max(Math.abs(ct.zScore), 1e-12) : 0;
  return {
    signal: ct.signal,
    currentRatio: ct.current,
    donchianHigh: ct.donchianCenter + sigma,
    donchianLow: ct.donchianCenter - sigma,
    donchianCenter: ct.donchianCenter,
    zScore: ct.zScore,
    fastRsi: ct.fastRsi,
  };
};

export const computeSignal = (
  strategyType: StrategyType,
  candles: ParsedSyntheticCandle[],
  length: number,
  detectionSource: 'wick' | 'close',
  zscoreEntry: number,
  longEnabled: boolean,
  shortEnabled: boolean
): ComputedSignal => {
  if (strategyType === 'stat_arb_zscore') {
    return computeStatArbSignal(
      candles,
      length,
      zscoreEntry,
      longEnabled,
      shortEnabled
    );
  }

  if (isCtFractalStrategyType(strategyType)) {
    return computeCtFractalSignal(candles, length, zscoreEntry, longEnabled, shortEnabled);
  }

  if (isMomentumScalpStrategyType(strategyType)) {
    const params = extractMomentumScalpParams({
      price_channel_length: length,
      zscore_entry: zscoreEntry,
      long_enabled: longEnabled,
      short_enabled: shortEnabled,
    } as Strategy);
    const idx = candles.length - 1;
    const ms = computeMomentumScalpSignalAtIndex(candles, idx, params);
    return {
      signal: ms.signal,
      currentRatio: ms.current,
      donchianHigh: ms.current,
      donchianLow: ms.current,
      donchianCenter: ms.current,
      zScore: ms.adx,
      fastRsi: ms.plusDi,
    };
  }

  if (isMrs2StrategyType(strategyType)) {
    const params = extractMrs2Params({
      price_channel_length: length,
      zscore_entry: zscoreEntry,
      long_enabled: longEnabled,
      short_enabled: shortEnabled,
    } as Strategy);
    const idx = candles.length - 1;
    const action = evaluateMrs2Bar(candles, idx, params, 'flat', null);
    return {
      signal: action.signal,
      currentRatio: action.fillPrice || action.current,
      donchianHigh: action.levels?.entryShort ?? action.current,
      donchianLow: action.levels?.entryLong ?? action.current,
      donchianCenter: action.current,
      zScore: null,
    };
  }

  if (isZzPivotStrategyType(strategyType)) {
    return computeZzPivotSignal(
      candles,
      length,
      strategyType,
      longEnabled,
      shortEnabled,
      resolveZzBreakMode(detectionSource),
    );
  }

  return computeDonchianSignal(
    candles,
    length,
    detectionSource,
    longEnabled,
    shortEnabled
  );
};

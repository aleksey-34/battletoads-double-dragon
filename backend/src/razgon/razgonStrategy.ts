// ─── Razgon Strategy: MicroDonchian Momentum Scalping ────────────────────────
import logger from '../utils/logger';
import type { Candle1m } from './razgonTypes';

export type MomentumSignal = 'long' | 'short' | 'none';

export interface MomentumSignalResult {
  signal: MomentumSignal;
  donchianHigh: number;
  donchianLow: number;
  volume: number;
  avgVolume: number;
  normAtr: number;
}

// ── Donchian Channel (micro) ──────────────────────────────────────────────

/**
 * Compute Donchian High / Low from closed candles.
 * Uses close prices (not wicks) — more conservative for 1m scalping.
 */
export function donchianChannel(candles: Candle1m[], period: number): { high: number; low: number } {
  if (candles.length < period) {
    return { high: NaN, low: NaN };
  }
  const window = candles.slice(-period);
  let high = -Infinity;
  let low = Infinity;
  for (const c of window) {
    // Use wicks (high/low) instead of close for more responsive breakout detection
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { high, low };
}

// ── Volume Spike Detector ─────────────────────────────────────────────────

/**
 * Average volume over last `period` candles (excluding the current one).
 */
export function avgVolume(candles: Candle1m[], period: number = 20): number {
  if (candles.length < period) return 0;
  const window = candles.slice(-period);
  let sum = 0;
  for (const c of window) sum += c.volume;
  return sum / period;
}

/**
 * Check if current candle volume exceeds k * average.
 */
export function isVolumeSpike(currentVolume: number, avg: number, multiplier: number): boolean {
  if (avg <= 0) return false;
  return currentVolume >= avg * multiplier;
}

// ── ATR Filter (Normalized) ──────────────────────────────────────────────

/**
 * Compute Average True Range over `period` candles.
 * Returns normalised ATR = ATR / close (dimensionless).
 */
export function normalisedATR(candles: Candle1m[], period: number = 14): number {
  if (candles.length < period + 1) return 0;
  const relevant = candles.slice(-(period + 1));
  let atrSum = 0;
  for (let i = 1; i <= period; i++) {
    const curr = relevant[i];
    const prev = relevant[i - 1];
    const tr = Math.max(
      curr.high - curr.low,
      Math.abs(curr.high - prev.close),
      Math.abs(curr.low - prev.close),
    );
    atrSum += tr;
  }
  const atr = atrSum / period;
  const lastClose = relevant[relevant.length - 1].close;
  return lastClose > 0 ? atr / lastClose : 0;
}

// ── Main Signal Generator ────────────────────────────────────────────────

/**
 * Generate MicroDonchian signal.
 *
 * @param closedCandles - Array of CLOSED 1m candles (newest last), at least
 *   max(donchianPeriod, 20, 15) + 1 candles needed.
 * @param currentPrice - latest tick price (may be mid-candle)
 * @param currentVolume - volume of the forming candle so far
 * @param donchianPeriod - lookback for Donchian (default 15)
 * @param volumeMultiplier - spike threshold (default 2.0)
 * @param atrMin - minimum normalised ATR to trade (default 0.005)
 */
export function computeMomentumSignal(
  closedCandles: Candle1m[],
  currentPrice: number,
  currentVolume: number,
  donchianPeriod: number = 15,
  volumeMultiplier: number = 2.0,
  atrMin: number = 0.005,
): MomentumSignalResult {
  const noSignal: MomentumSignalResult = {
    signal: 'none',
    donchianHigh: NaN,
    donchianLow: NaN,
    volume: currentVolume,
    avgVolume: 0,
    normAtr: 0,
  };

  if (closedCandles.length < Math.max(donchianPeriod, 21)) {
    return noSignal;
  }

  // 1. Donchian channel on closed candles (exclude current forming bar)
  const { high: dHigh, low: dLow } = donchianChannel(closedCandles, donchianPeriod);
  if (!Number.isFinite(dHigh) || !Number.isFinite(dLow)) return noSignal;

  // 2. Volume filter
  const avg = avgVolume(closedCandles, 20);

  // 3. ATR filter
  const nAtr = normalisedATR(closedCandles, 14);

  const result: MomentumSignalResult = {
    signal: 'none',
    donchianHigh: dHigh,
    donchianLow: dLow,
    volume: currentVolume,
    avgVolume: avg,
    normAtr: nAtr,
  };

  // --- Aggressive scalping logic ---
  // Two independent entry triggers (either one is enough):
  //
  // Trigger A: Donchian breakout (price beyond channel edge)
  //   → momentum trade, ride the breakout
  //
  // Trigger B: Volume spike + price moving in one direction
  //   → volume-driven move, even without full breakout
  //
  // ATR is informational only — does NOT block entries

  const volOk = isVolumeSpike(currentVolume, avg, volumeMultiplier);
  const nearPct = 0.001; // 0.1% proximity zone

  const breakoutHigh = currentPrice >= dHigh;
  const breakoutLow = currentPrice <= dLow;
  const nearHigh = currentPrice >= dHigh * (1 - nearPct);
  const nearLow = currentPrice <= dLow * (1 + nearPct);

  // Trigger A: clean breakout (no volume requirement)
  if (breakoutHigh) {
    result.signal = 'long';
  } else if (breakoutLow) {
    result.signal = 'short';
  }
  // Trigger B: volume spike + near channel edge
  else if (volOk && nearHigh) {
    result.signal = 'long';
  } else if (volOk && nearLow) {
    result.signal = 'short';
  }

  return result;
}

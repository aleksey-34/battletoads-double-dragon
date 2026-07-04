import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMomentumScalpIndicatorSeries,
  computeMomentumScalpSignalAtIndex,
  extractMomentumScalpParams,
  momentumScalpTpSlPrices,
  MOMENTUM_SCALP_TV_DEFAULTS,
} from '../bot/momentumScalpSignal';
import { runMomentumScalpBacktest } from '../research/momentumScalpBacktest';

const synthTrendUp = (): Array<{ open: number; high: number; low: number; close: number; timeMs: number }> => {
  const bars: Array<{ open: number; high: number; low: number; close: number; timeMs: number }> = [];
  let px = 100;
  for (let i = 0; i < 300; i += 1) {
    const drift = i > 120 ? 0.35 : i > 80 ? 0.08 : -0.02;
    const open = px;
    px = Math.max(1, px + drift + Math.sin(i / 7) * 0.15);
    const close = px;
    bars.push({
      timeMs: i * 900_000,
      open,
      high: Math.max(open, close) * 1.002,
      low: Math.min(open, close) * 0.998,
      close,
    });
  }
  return bars;
};

describe('momentumScalpSignal', () => {
  it('extracts params from strategy field mapping', () => {
    const p = extractMomentumScalpParams({
      price_channel_length: 8,
      zscore_entry: 21,
      zscore_exit: 20,
      zscore_stop: 1.2,
      take_profit_percent: 2,
      long_enabled: true,
      short_enabled: true,
    });
    assert.equal(p.emaFastPeriod, 8);
    assert.equal(p.emaSlowPeriod, 21);
    assert.equal(p.adxMin, 20);
    assert.equal(p.tpPercent, 2);
    assert.equal(p.slPercent, 1.2);
  });

  it('builds indicator series with finite ADX after warmup', () => {
    const bars = synthTrendUp();
    const series = buildMomentumScalpIndicatorSeries(bars, MOMENTUM_SCALP_TV_DEFAULTS);
    const finiteAdx = series.adx.filter((v) => Number.isFinite(v));
    assert.ok(series.warmup < bars.length - 1);
    assert.ok(finiteAdx.length > 10);
  });

  it('computes TP/SL prices symmetrically', () => {
    const { tp, sl } = momentumScalpTpSlPrices('long', 100, MOMENTUM_SCALP_TV_DEFAULTS);
    assert.ok(tp > 100);
    assert.ok(sl < 100);
    const sh = momentumScalpTpSlPrices('short', 100, MOMENTUM_SCALP_TV_DEFAULTS);
    assert.ok(sh.tp < 100);
    assert.ok(sh.sl > 100);
  });

  it('research backtest produces equity curve', () => {
    const bars = synthTrendUp();
    const res = runMomentumScalpBacktest(bars, {
      ...MOMENTUM_SCALP_TV_DEFAULTS,
      initialBalance: 1000,
      positionFraction: 0.5,
      barMinutes: 15,
    });
    assert.ok(res.summary.tradesCount >= 0);
    assert.ok(res.equityCurve.length > 0);
  });

  it('blocks entry when ADX is below minimum', () => {
    const bars = synthTrendUp();
    const series = buildMomentumScalpIndicatorSeries(bars, MOMENTUM_SCALP_TV_DEFAULTS);
    const strictParams = { ...MOMENTUM_SCALP_TV_DEFAULTS, adxMin: 99 };
    let blocked = 0;
    for (let i = series.warmup; i < bars.length; i += 1) {
      const sig = computeMomentumScalpSignalAtIndex(bars, i, strictParams, series);
      if (sig.signal !== 'none') blocked += 1;
    }
    assert.equal(blocked, 0);
  });

  it('detects opposite cross while in position', () => {
    const bars = synthTrendUp();
    const series = buildMomentumScalpIndicatorSeries(bars, MOMENTUM_SCALP_TV_DEFAULTS);
    let sawOppositeWhileLong = false;
    for (let i = series.warmup; i < bars.length; i += 1) {
      const sig = computeMomentumScalpSignalAtIndex(bars, i, MOMENTUM_SCALP_TV_DEFAULTS, series, 'long');
      if (sig.oppositeCross) {
        sawOppositeWhileLong = true;
        break;
      }
    }
    assert.ok(sawOppositeWhileLong, 'expected bear cross hint while holding long');
  });

  it('produces finite signals on sustained uptrend after warmup', () => {
    const bars = synthTrendUp();
    const series = buildMomentumScalpIndicatorSeries(bars, MOMENTUM_SCALP_TV_DEFAULTS);
    const signals: string[] = [];
    for (let i = series.warmup; i < bars.length; i += 1) {
      const sig = computeMomentumScalpSignalAtIndex(bars, i, MOMENTUM_SCALP_TV_DEFAULTS, series);
      if (sig.signal !== 'none') signals.push(sig.signal);
    }
    assert.ok(signals.length > 0);
    assert.ok(signals.every((s) => s === 'long' || s === 'short'));
  });
});

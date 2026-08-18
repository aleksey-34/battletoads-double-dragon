import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalizeInterval, intervalToMs } from './normalize';
import { resolveExecutionCandleContext } from './execution';
import type { ParsedSyntheticCandle } from './types';

const candle = (timeMs: number): ParsedSyntheticCandle => ({
  timeMs,
  open: 1,
  high: 1,
  low: 1,
  close: 1,
});

describe('intervalToMs', () => {
  it('canonicalizes 4H/4h to 4 hours, never 1h', () => {
    assert.equal(canonicalizeInterval('4H'), '4h');
    assert.equal(canonicalizeInterval('4h'), '4h');
    assert.equal(intervalToMs('4h'), 4 * 3600_000);
    assert.equal(intervalToMs('4H'), 4 * 3600_000);
    assert.equal(intervalToMs('1h'), 3600_000);
    assert.equal(intervalToMs('1H'), 3600_000);
  });

  it('parses minutes, days, weeks and keeps 1M as month', () => {
    assert.equal(intervalToMs('15m'), 15 * 60_000);
    assert.equal(intervalToMs('1d'), 86_400_000);
    assert.equal(intervalToMs('1w'), 7 * 86_400_000);
    assert.equal(canonicalizeInterval('1M'), '1M');
    assert.equal(intervalToMs('1M'), 30 * 86_400_000);
  });
});

describe('resolveExecutionCandleContext closed-bar', () => {
  const H = 3600_000;
  const barOpen = Date.parse('2026-08-18T12:00:00Z');
  const prevOpen = barOpen - 4 * H;

  const withNow = (nowMs: number, fn: () => void) => {
    const orig = Date.now;
    Date.now = () => nowMs;
    try {
      fn();
    } finally {
      Date.now = orig;
    }
  };

  it('does not treat a forming 4h/4H bar as closed after 1h', () => {
    const candles = [candle(prevOpen), candle(barOpen)];
    withNow(barOpen + H, () => {
      const ctxH = resolveExecutionCandleContext(candles, '4h', true);
      const ctxHUpper = resolveExecutionCandleContext(candles, '4H', true);
      assert.equal(ctxH.evaluatedBarTimeMs, prevOpen);
      assert.equal(ctxHUpper.evaluatedBarTimeMs, prevOpen);
    });
  });

  it('requires now >= barOpen + intervalMs before using the latest bar', () => {
    const candles = [candle(prevOpen), candle(barOpen)];
    withNow(barOpen + 4 * H - 1, () => {
      const ctx = resolveExecutionCandleContext(candles, '4h', true);
      assert.equal(ctx.evaluatedBarTimeMs, prevOpen);
    });
    withNow(barOpen + 4 * H, () => {
      const ctx = resolveExecutionCandleContext(candles, '4H', true);
      assert.equal(ctx.evaluatedBarTimeMs, barOpen);
    });
  });

  it('throws when no fully closed bar exists yet', () => {
    const candles = [candle(barOpen)];
    withNow(barOpen + H, () => {
      assert.throws(
        () => resolveExecutionCandleContext(candles, '4h', true),
        /No closed candles/,
      );
    });
  });
});

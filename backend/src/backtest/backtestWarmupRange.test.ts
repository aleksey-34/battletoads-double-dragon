import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveBacktestRangeIndices } from './backtestWarmupRange';

describe('resolveBacktestRangeIndices', () => {
  it('starts at firstInRangeIndex when warmup history exists before range', () => {
    // 5330 candles, range starts at index 5200, 120 warmup bars exist before range.
    const res = resolveBacktestRangeIndices({
      effectiveLength: 33,
      warmupBars: 120,
      firstInRangeIndex: 5200,
      lastInRangeIndex: 5320,
      candlesLength: 5330,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.startIndex, 5200);
      assert.equal(res.endIndex, 5320);
    }
  });

  it('does NOT extend start by warmupBars inside short sinceFix windows (old bug)', () => {
    const oldBugStart = 5200 + 120;
    const res = resolveBacktestRangeIndices({
      effectiveLength: 33,
      warmupBars: 120,
      firstInRangeIndex: 5200,
      lastInRangeIndex: 5250,
      candlesLength: 5330,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.startIndex < oldBugStart, 'must not add warmupBars on top of range start');
      assert.equal(res.startIndex, 5200);
    }
  });

  it('allows firstInRangeIndex=0 when enough total candles for effectiveLength', () => {
    const res = resolveBacktestRangeIndices({
      effectiveLength: 120,
      warmupBars: 120,
      firstInRangeIndex: 0,
      lastInRangeIndex: 500,
      candlesLength: 4000,
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.startIndex, 120);
    }
  });

  it('skips when insufficient total candle history for effectiveLength', () => {
    const res = resolveBacktestRangeIndices({
      effectiveLength: 120,
      warmupBars: 120,
      firstInRangeIndex: 80,
      lastInRangeIndex: 200,
      candlesLength: 100,
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.reason, /Insufficient candle history/);
    }
  });

  it('skips when endIndex <= startIndex', () => {
    const res = resolveBacktestRangeIndices({
      effectiveLength: 33,
      warmupBars: 120,
      firstInRangeIndex: 5200,
      lastInRangeIndex: 5190,
      candlesLength: 5330,
    });
    assert.equal(res.ok, false);
  });
});

export type BacktestRangeResolution =
  | { ok: true; startIndex: number; endIndex: number }
  | { ok: false; reason: string };

/** Pure helper for backtest date-window indexing (unit-tested). */
export const resolveBacktestRangeIndices = (input: {
  effectiveLength: number;
  warmupBars: number;
  firstInRangeIndex: number;
  lastInRangeIndex: number;
  candlesLength: number;
}): BacktestRangeResolution => {
  const effectiveLength = Math.max(0, Math.floor(input.effectiveLength));
  const warmupBars = Math.max(0, Math.floor(input.warmupBars));
  const firstInRangeIndex = Math.max(0, Math.floor(input.firstInRangeIndex));
  const lastInRangeIndex = Math.min(
    Math.max(0, Math.floor(input.candlesLength) - 1),
    Math.floor(input.lastInRangeIndex),
  );

  const minHistoryBars = Math.max(effectiveLength, warmupBars);
  if (firstInRangeIndex < minHistoryBars) {
    return {
      ok: false,
      reason: `Insufficient warmup history before range start (index ${firstInRangeIndex}, need ${minHistoryBars})`,
    };
  }

  const startIndex = Math.max(effectiveLength, firstInRangeIndex);
  const endIndex = lastInRangeIndex;

  if (endIndex <= startIndex) {
    return { ok: false, reason: 'No executable candles in selected date range' };
  }

  return { ok: true, startIndex, endIndex };
};

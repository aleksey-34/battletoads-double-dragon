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
  const firstInRangeIndex = Math.max(0, Math.floor(input.firstInRangeIndex));
  const candlesLength = Math.max(0, Math.floor(input.candlesLength));
  const lastInRangeIndex = Math.min(
    Math.max(0, candlesLength - 1),
    Math.floor(input.lastInRangeIndex),
  );

  // Warmup bars are fetched before dateFrom (see engine fetchStartMs). Do NOT add
  // warmupBars on top of firstInRangeIndex — that wrongly skips short sinceFix
  // windows. Only require enough bars for indicator effectiveLength.
  const startIndex = Math.max(effectiveLength, firstInRangeIndex);
  const endIndex = lastInRangeIndex;

  if (startIndex >= candlesLength) {
    return {
      ok: false,
      reason: `Insufficient candle history (need ${startIndex} bars, have ${candlesLength})`,
    };
  }

  if (endIndex <= startIndex) {
    return { ok: false, reason: 'No executable candles in selected date range' };
  }

  return { ok: true, startIndex, endIndex };
};

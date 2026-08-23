export type TradeDriftLegStats = {
  trades: number;
  bySym: Record<string, { n: number }>;
};

export type LiveDriftLegStats = {
  n: number;
  bySym: Record<string, { n: number }>;
};

export type TradeDriftCompareResult = {
  freqX: number | null;
  hot: Array<{ sym: string; bt: number; live: number }>;
};

/** Compare fair backtest entry counts vs live monitoring entries (nightly roll / drift UI). */
export const tradeDriftVsLive = (
  bt: TradeDriftLegStats,
  live: LiveDriftLegStats,
): TradeDriftCompareResult => {
  const freqX = bt.trades > 0 ? +(live.n / bt.trades).toFixed(2) : null;
  const hot: Array<{ sym: string; bt: number; live: number }> = [];
  const syms = new Set([...Object.keys(bt.bySym || {}), ...Object.keys(live.bySym || {})]);
  for (const sym of syms) {
    const b = bt.bySym?.[sym]?.n || 0;
    const l = live.bySym?.[sym]?.n || 0;
    if (l >= 8 && (b === 0 || l > b * 2)) {
      hot.push({ sym, bt: b, live: l });
    }
  }
  hot.sort((a, c) => (c.live - c.bt) - (a.live - a.bt));
  return { freqX, hot: hot.slice(0, 6) };
};

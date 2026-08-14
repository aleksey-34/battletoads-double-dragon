export type MetricKind = 'return' | 'drawdown' | 'pf';

export const formatStorefrontNumber = (value: unknown, digits = 2): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  return numeric.toFixed(digits).replace(/\.?0+$/, '');
};

export const formatStorefrontPercent = (value: unknown, digits = 2): string => {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '—';
  }
  return `${formatStorefrontNumber(numeric, digits)}%`;
};

export const metricTone = (value: number, kind: MetricKind): 'positive' | 'negative' | 'neutral' => {
  if (!Number.isFinite(value)) {
    return 'neutral';
  }
  if (kind === 'drawdown') {
    return value <= 12 ? 'positive' : value <= 25 ? 'neutral' : 'negative';
  }
  if (kind === 'pf') {
    return value >= 1.5 ? 'positive' : value >= 1 ? 'neutral' : 'negative';
  }
  return value >= 0 ? 'positive' : 'negative';
};

export type LinePoint = { time: number; value: number };

export const pointsToChartSeries = (points: number[], periodDays?: number): LinePoint[] => {
  if (!Array.isArray(points) || points.length < 2) {
    return [];
  }
  const nowSec = Math.floor(Date.now() / 1000);
  const dayS = 86_400;
  const spanDays = Number(periodDays || 0) > 0 ? Number(periodDays) : Math.max(1, points.length - 1);
  const totalSpan = Math.max(spanDays, 1) * dayS;
  const startSec = nowSec - totalSpan;
  const step = totalSpan / Math.max(points.length - 1, 1);
  return points.map((value, index) => ({
    time: Math.floor(startSec + index * step),
    value: Number(value),
  }));
};

export const equityPointsToSeries = (points: number[], periodDays?: number): LinePoint[] => {
  if (!Array.isArray(points) || points.length === 0) {
    return [];
  }
  const spanDays = Number.isFinite(Number(periodDays)) && Number(periodDays) > 0
    ? Number(periodDays)
    : Math.max(1, points.length);
  const stepMs = (spanDays * 86_400_000) / Math.max(1, points.length - 1);
  const now = Date.now();
  return points.map((value, index) => ({
    time: Math.floor((now - (points.length - 1 - index) * stepMs) / 1000),
    value: Number(value),
  }));
};

/** Deterministic sparkline when snapshot has ret/dd but no saved equity curve. */
export const syntheticEquitySeriesFromMetrics = (opts: {
  capital?: number;
  ret?: number;
  dd?: number;
  periodDays?: number;
  points?: number;
}): LinePoint[] => {
  const start = Number(opts.capital) > 0 ? Number(opts.capital) : 10000;
  const ret = Number.isFinite(Number(opts.ret)) ? Number(opts.ret) : 0;
  const dd = Math.max(0, Number.isFinite(Number(opts.dd)) ? Number(opts.dd) : Math.abs(ret) * 0.25);
  const days = Math.max(30, Number(opts.periodDays) > 0 ? Number(opts.periodDays) : 850);
  const n = Math.max(40, Math.min(120, Number(opts.points) > 0 ? Number(opts.points) : 64));
  const finalEquity = start * (1 + ret / 100);
  let seed = Math.floor((ret + 1000) * 17 + dd * 113 + days * 7);
  if (!Number.isFinite(seed) || seed <= 0) seed = 1234567;
  const nextRand = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const nextGaussian = (): number => {
    const u1 = Math.max(1e-9, nextRand());
    const u2 = Math.max(1e-9, nextRand());
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  };
  const drift = Math.log(Math.max(0.05, finalEquity) / start) / n;
  const vol = Math.max(0.0015, (dd / 100) / Math.sqrt(n));
  const raw: number[] = [start];
  let eq = start;
  for (let i = 1; i <= n; i += 1) {
    eq = Math.max(start * 0.03, eq * Math.exp(drift + nextGaussian() * vol));
    raw.push(eq);
  }
  const scale = Math.max(0.05, finalEquity) / Math.max(start * 0.03, raw[raw.length - 1]);
  const nowSec = Math.floor(Date.now() / 1000);
  const span = days * 86_400;
  const step = span / n;
  return raw.map((value, index) => ({
    time: Math.floor(nowSec - span + index * step),
    value: Number((value * scale).toFixed(2)),
  }));
};

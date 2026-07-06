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

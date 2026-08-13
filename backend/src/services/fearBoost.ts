/**
 * Lag-1 "boost after fear": after a closed fear-day, the next `holdDays`
 * UTC calendar days scale NEW entry lots.
 *
 * Fear day (union):
 *   BTC daily return ≤ −3%
 *   and/or real S&P (^GSPC / stooq ^spx) ≤ −1.5%
 *   and/or VIX daily change ≥ +15%
 *
 * Only closed daily bars — never the in-progress session (no look-ahead).
 */

export type FearBoostConfig = {
  enabled?: boolean;
  lotMultiplier?: number;
  holdDays?: number;
  btcDailyReturnLte?: number;
  spxDailyReturnLte?: number;
  vixDailyChangeGte?: number;
  applyToStrategyTypes?: string[];
};

export type DailyClose = { date: string; close: number };

export const DEFAULT_FEAR_BOOST: Required<Omit<FearBoostConfig, 'applyToStrategyTypes'>> = {
  enabled: true,
  lotMultiplier: 1.25,
  holdDays: 2,
  btcDailyReturnLte: -0.03,
  spxDailyReturnLte: -0.015,
  vixDailyChangeGte: 0.15,
};

const MS_DAY = 86_400_000;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

export const utcDayStartMs = (timeMs: number): number => {
  const d = new Date(timeMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export const dateToUtcDayStartMs = (date: string): number => {
  const [y, m, day] = String(date || '').split('-').map((x) => Number(x));
  if (!y || !m || !day) return 0;
  return Date.UTC(y, m - 1, day);
};

export const parseFearBoost = (raw: unknown): FearBoostConfig | null => {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.enabled === false) {
    return { enabled: false };
  }
  const types = Array.isArray(o.applyToStrategyTypes)
    ? o.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
    : undefined;
  return {
    enabled: o.enabled !== false,
    lotMultiplier: Number(o.lotMultiplier ?? DEFAULT_FEAR_BOOST.lotMultiplier),
    holdDays: Number(o.holdDays ?? DEFAULT_FEAR_BOOST.holdDays),
    btcDailyReturnLte: Number(o.btcDailyReturnLte ?? DEFAULT_FEAR_BOOST.btcDailyReturnLte),
    spxDailyReturnLte: Number(o.spxDailyReturnLte ?? DEFAULT_FEAR_BOOST.spxDailyReturnLte),
    vixDailyChangeGte: Number(o.vixDailyChangeGte ?? DEFAULT_FEAR_BOOST.vixDailyChangeGte),
    ...(types && types.length ? { applyToStrategyTypes: types } : {}),
  };
};

export const dailyReturns = (series: DailyClose[]): Record<string, number> => {
  const sorted = [...series]
    .filter((r) => r && r.date && Number.isFinite(r.close) && r.close > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  const out: Record<string, number> = {};
  for (let i = 1; i < sorted.length; i += 1) {
    const prev = sorted[i - 1].close;
    if (prev > 0) {
      out[sorted[i].date] = sorted[i].close / prev - 1;
    }
  }
  return out;
};

/** Trigger dates → active UTC days D+1 .. D+hold (lag-1). */
export const lag1ActiveDates = (triggerDates: string[], holdDays: number): string[] => {
  const hold = clamp(Math.floor(holdDays), 1, 7);
  const active = new Set<string>();
  for (const d of triggerDates) {
    const start = dateToUtcDayStartMs(d);
    if (!start) continue;
    for (let i = 1; i <= hold; i += 1) {
      const ms = start + i * MS_DAY;
      const dt = new Date(ms);
      const y = dt.getUTCFullYear();
      const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
      const day = String(dt.getUTCDate()).padStart(2, '0');
      active.add(`${y}-${m}-${day}`);
    }
  }
  return [...active].sort();
};

export const computeFearUnionActiveDates = (
  btc: DailyClose[],
  spx: DailyClose[],
  vix: DailyClose[],
  config?: FearBoostConfig | null,
): { triggers: string[]; active: string[] } => {
  const cfg = parseFearBoost(config || DEFAULT_FEAR_BOOST) || DEFAULT_FEAR_BOOST;
  const btcR = dailyReturns(btc);
  const spxR = dailyReturns(spx);
  const vixR = dailyReturns(vix);
  const btcTh = Number(cfg.btcDailyReturnLte ?? DEFAULT_FEAR_BOOST.btcDailyReturnLte);
  const spxTh = Number(cfg.spxDailyReturnLte ?? DEFAULT_FEAR_BOOST.spxDailyReturnLte);
  const vixTh = Number(cfg.vixDailyChangeGte ?? DEFAULT_FEAR_BOOST.vixDailyChangeGte);
  const triggers = new Set<string>();
  for (const [d, r] of Object.entries(btcR)) {
    if (r <= btcTh) triggers.add(d);
  }
  for (const [d, r] of Object.entries(spxR)) {
    if (r <= spxTh) triggers.add(d);
  }
  for (const [d, r] of Object.entries(vixR)) {
    if (r >= vixTh) triggers.add(d);
  }
  const triggerList = [...triggers].sort();
  return {
    triggers: triggerList,
    active: lag1ActiveDates(triggerList, Number(cfg.holdDays ?? DEFAULT_FEAR_BOOST.holdDays)),
  };
};

export const lotMultiplierForFearDay = (
  config: FearBoostConfig | null | undefined,
  strategyType: string,
  timeMs: number,
  activeDayStartsMs: Set<number>,
): number => {
  if (!config || config.enabled === false) return 1;
  const day = utcDayStartMs(timeMs);
  if (!activeDayStartsMs.has(day)) return 1;
  const types = Array.isArray(config.applyToStrategyTypes)
    ? config.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
    : [];
  if (types.length > 0 && !types.includes(String(strategyType || '').trim())) {
    return 1;
  }
  const m = Number(config.lotMultiplier ?? DEFAULT_FEAR_BOOST.lotMultiplier);
  if (!Number.isFinite(m) || m <= 0) return 1;
  return Math.min(3, m);
};

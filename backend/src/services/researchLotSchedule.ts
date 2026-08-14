/**
 * Research overlay: scale NEW entry lots on precomputed active UTC days.
 * Used for lag-1 "boost after fear" (and similar) without look-ahead:
 * the research script marks days that are already known at 00:00 UTC.
 *
 * BT / research uses a precomputed day list. Live uses `fearBoostRuntime`
 * with the same lag-1 union (BTC/SPX/VIX) and multiplier.
 */

export type ResearchLotScheduleConfig = {
  enabled?: boolean;
  /**
   * UTC day starts (ms at 00:00Z) where the multiplier applies.
   * Prefer precomputing lag-1 active days outside the engine.
   */
  activeDayStartsMs?: number[];
  /** Lot scale on active days (default 1.25). May be >1 (boost) or <1 (cut). */
  lotMultiplier?: number;
  /**
   * If non-empty, only these strategy_type values are scaled.
   * Empty / omitted = all entries.
   */
  applyToStrategyTypes?: string[];
};

type StrategyLike = { strategy_type?: string };

const MS_DAY = 86_400_000;

const utcDayStart = (timeMs: number): number => {
  const d = new Date(timeMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export class ResearchLotScheduleTracker {
  private readonly activeDays: Set<number>;
  private readonly lotMultiplier: number;
  private readonly applyToStrategyTypes: Set<string> | null;

  constructor(config: ResearchLotScheduleConfig | null | undefined) {
    const days = Array.isArray(config?.activeDayStartsMs)
      ? config.activeDayStartsMs
        .map((n) => Math.floor(Number(n)))
        .filter((n) => Number.isFinite(n) && n > 0)
        .map((n) => Math.floor(n / MS_DAY) * MS_DAY)
      : [];
    this.activeDays = new Set(days);
    const m = Number(config?.lotMultiplier ?? 1.25);
    this.lotMultiplier = Number.isFinite(m) && m >= 0 ? Math.min(3, m) : 1.25;
    const types = Array.isArray(config?.applyToStrategyTypes)
      ? config.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
      : [];
    this.applyToStrategyTypes = types.length > 0 ? new Set(types) : null;
  }

  static tryCreate(
    config: ResearchLotScheduleConfig | null | undefined,
  ): ResearchLotScheduleTracker | null {
    if (!config || config.enabled !== true) {
      return null;
    }
    const tracker = new ResearchLotScheduleTracker(config);
    if (tracker.activeDays.size === 0) {
      return null;
    }
    return tracker;
  }

  lotMultiplierFor(strategy: StrategyLike, timeMs: number): number {
    const day = utcDayStart(timeMs);
    if (!this.activeDays.has(day)) {
      return 1;
    }
    if (this.applyToStrategyTypes) {
      const stype = String(strategy.strategy_type || '').trim();
      if (!this.applyToStrategyTypes.has(stype)) {
        return 1;
      }
    }
    return this.lotMultiplier;
  }

  get activeDayCount(): number {
    return this.activeDays.size;
  }
}

export const parseResearchLotSchedule = (raw: unknown): ResearchLotScheduleConfig | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return raw as ResearchLotScheduleConfig;
};

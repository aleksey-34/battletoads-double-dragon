/**
 * After a "sync loss day" (>=N legs closed red), cut lot on selected breakout
 * symbols for pauseDays. Research overlay for fat-tail defense.
 */

export type FatTailSyncConfig = {
  enabled?: boolean;
  /** Min distinct strategies with negative close same UTC day (default 5). */
  minLosingLegs?: number;
  /** Lot scale next day(s) for matching legs (default 0.5). */
  lotMultiplier?: number;
  /** How many calendar days to keep cut after sync day (default 1). */
  pauseDays?: number;
  /** Only these strategy_type values are cut (default zz_breakout). */
  strategyTypes?: string[];
  /** Optional base symbols filter, e.g. ORDIUSDT / WLDUSDT. Empty = all of type. */
  baseSymbols?: string[];
};

type StrategyLike = {
  strategy_type?: string;
  base_symbol?: string;
};

const MS_DAY = 86_400_000;

const utcDayStart = (timeMs: number): number => {
  const d = new Date(timeMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
};

export class FatTailSyncTracker {
  private readonly minLosingLegs: number;
  private readonly lotMultiplier: number;
  private readonly pauseDays: number;
  private readonly strategyTypes: Set<string>;
  private readonly baseSymbols: Set<string> | null;
  private readonly lossLegsByDay = new Map<number, Set<number>>();
  private readonly cooldownDays = new Set<number>();

  constructor(config: FatTailSyncConfig | null | undefined) {
    this.minLosingLegs = Math.max(2, Math.floor(Number(config?.minLosingLegs ?? 5)));
    this.lotMultiplier = Math.min(1, Math.max(0, Number(config?.lotMultiplier ?? 0.5)));
    this.pauseDays = Math.max(1, Math.floor(Number(config?.pauseDays ?? 1)));
    const types = Array.isArray(config?.strategyTypes) && config.strategyTypes.length > 0
      ? config.strategyTypes
      : ['zz_breakout'];
    this.strategyTypes = new Set(types.map((t) => String(t || '').trim()).filter(Boolean));
    const bases = Array.isArray(config?.baseSymbols)
      ? config.baseSymbols.map((s) => String(s || '').trim().toUpperCase()).filter(Boolean)
      : [];
    this.baseSymbols = bases.length > 0 ? new Set(bases) : null;
  }

  static tryCreate(config: FatTailSyncConfig | null | undefined): FatTailSyncTracker | null {
    if (!config || config.enabled !== true) {
      return null;
    }
    return new FatTailSyncTracker(config);
  }

  recordClose(strategyId: number, netPnl: number, timeMs: number): void {
    if (!(netPnl < 0) || !Number.isFinite(strategyId) || strategyId <= 0) {
      return;
    }
    const day = utcDayStart(timeMs);
    let set = this.lossLegsByDay.get(day);
    if (!set) {
      set = new Set();
      this.lossLegsByDay.set(day, set);
    }
    set.add(strategyId);
    if (set.size >= this.minLosingLegs) {
      for (let i = 1; i <= this.pauseDays; i += 1) {
        this.cooldownDays.add(day + i * MS_DAY);
      }
    }
  }

  lotMultiplierFor(strategy: StrategyLike, timeMs: number): number {
    const day = utcDayStart(timeMs);
    if (!this.cooldownDays.has(day)) {
      return 1;
    }
    const stype = String(strategy.strategy_type || '').trim();
    if (!this.strategyTypes.has(stype)) {
      return 1;
    }
    if (this.baseSymbols) {
      const base = String(strategy.base_symbol || '').trim().toUpperCase();
      if (!this.baseSymbols.has(base)) {
        return 1;
      }
    }
    return this.lotMultiplier;
  }
}

export const parseFatTailSync = (raw: unknown): FatTailSyncConfig | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return raw as FatTailSyncConfig;
};

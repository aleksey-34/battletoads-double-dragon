/**
 * Portfolio-level circuit breaker: when drawdown from rolling peak exceeds threshold,
 * scale new entry lot by lotMultiplier for pauseDays.
 */

export type PortfolioCircuitBreakerConfig = {
  enabled?: boolean;
  /** Rolling peak window (default 30). */
  peakWindowDays?: number;
  /** DD % from rolling peak that triggers CB (default 8). */
  ddTriggerPercent?: number;
  /** Alias for ddTriggerPercent. */
  ddTrigger?: number;
  /** Lot scale while active (default 0.5). */
  lotMultiplier?: number;
  /** Alias for lotMultiplier. */
  lotMult?: number;
  /** Cooldown duration after trigger (default 14). */
  pauseDays?: number;
  /**
   * If non-empty, lotMultiplier applies only to these strategy_type values
   * (e.g. ["zz_breakout"]). Other types keep full lot (1.0) during CB.
   */
  applyToStrategyTypes?: string[];
};

export type PortfolioCircuitBreakerState = {
  cooldownUntilMs: number;
  triggerCount: number;
  /** Recent (timeMs, equity) for rolling peak — trimmed to window. */
  samples: Array<{ timeMs: number; equity: number }>;
};

export type PortfolioCircuitBreakerUpdate = {
  lotMultiplier: number;
  drawdownPercent: number;
  rollingPeak: number;
  triggered: boolean;
  inCooldown: boolean;
  triggerCount: number;
};

const MS_DAY = 86_400_000;

const clamp = (value: number, min: number, max: number): number => (
  Math.min(max, Math.max(min, value))
);

export const DEFAULT_PORTFOLIO_CIRCUIT_BREAKER: Required<{
  enabled: boolean;
  peakWindowDays: number;
  ddTriggerPercent: number;
  lotMultiplier: number;
  pauseDays: number;
}> = {
  enabled: true,
  peakWindowDays: 30,
  ddTriggerPercent: 8,
  lotMultiplier: 0.5,
  pauseDays: 14,
};

export const normalizePortfolioCircuitBreaker = (
  raw: PortfolioCircuitBreakerConfig | null | undefined,
): Required<{
  enabled: boolean;
  peakWindowDays: number;
  ddTriggerPercent: number;
  lotMultiplier: number;
  pauseDays: number;
}> | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  if (raw.enabled === false) {
    return null;
  }
  const ddRaw = raw.ddTriggerPercent ?? raw.ddTrigger;
  const lotRaw = raw.lotMultiplier ?? raw.lotMult;
  return {
    enabled: true,
    peakWindowDays: clamp(Math.floor(Number(raw.peakWindowDays ?? 30)), 1, 365),
    ddTriggerPercent: clamp(Number(ddRaw ?? 8), 0.5, 80),
    lotMultiplier: clamp(Number(lotRaw ?? 0.5), 0, 1),
    pauseDays: clamp(Math.floor(Number(raw.pauseDays ?? 14)), 1, 90),
  };
};

export const parsePortfolioCircuitBreaker = (raw: unknown): PortfolioCircuitBreakerConfig | null => {
  if (!raw || typeof raw !== 'object') {
    return null;
  }
  return raw as PortfolioCircuitBreakerConfig;
};

export class PortfolioCircuitBreakerTracker {
  private readonly config: NonNullable<ReturnType<typeof normalizePortfolioCircuitBreaker>>;
  private readonly applyToStrategyTypes: Set<string> | null;
  private cooldownUntilMs = 0;
  private triggerCount = 0;
  private samples: Array<{ timeMs: number; equity: number }> = [];
  private lastRawLotMultiplier = 1;

  constructor(config: PortfolioCircuitBreakerConfig | null | undefined) {
    const normalized = normalizePortfolioCircuitBreaker(config);
    if (!normalized) {
      throw new Error('Portfolio circuit breaker config is disabled or invalid');
    }
    this.config = normalized;
    const rawTypes = Array.isArray(config?.applyToStrategyTypes)
      ? config.applyToStrategyTypes.map((t) => String(t || '').trim()).filter(Boolean)
      : [];
    this.applyToStrategyTypes = rawTypes.length > 0 ? new Set(rawTypes) : null;
  }

  static tryCreate(
    config: PortfolioCircuitBreakerConfig | null | undefined,
  ): PortfolioCircuitBreakerTracker | null {
    const normalized = normalizePortfolioCircuitBreaker(config);
    if (!normalized) {
      return null;
    }
    return new PortfolioCircuitBreakerTracker(config);
  }

  /**
   * Effective lot multiplier for a concrete strategy type.
   * Tier mode: only listed types get the reduced CB lot; others stay at 1.0.
   */
  lotMultiplierForStrategyType(strategyType: string, rawLotMultiplier?: number): number {
    const raw = Number.isFinite(Number(rawLotMultiplier))
      ? Number(rawLotMultiplier)
      : this.lastRawLotMultiplier;
    if (!this.applyToStrategyTypes || this.applyToStrategyTypes.size === 0) {
      return raw;
    }
    const token = String(strategyType || '').trim();
    return this.applyToStrategyTypes.has(token) ? raw : 1;
  }

  restoreState(state: PortfolioCircuitBreakerState | null | undefined): void {
    if (!state || typeof state !== 'object') {
      return;
    }
    this.cooldownUntilMs = Number.isFinite(Number(state.cooldownUntilMs))
      ? Math.max(0, Number(state.cooldownUntilMs))
      : 0;
    this.triggerCount = Number.isFinite(Number(state.triggerCount))
      ? Math.max(0, Math.floor(Number(state.triggerCount)))
      : 0;
    if (Array.isArray(state.samples)) {
      this.samples = state.samples
        .map((item) => ({
          timeMs: Number(item?.timeMs),
          equity: Number(item?.equity),
        }))
        .filter((item) => Number.isFinite(item.timeMs) && Number.isFinite(item.equity) && item.equity > 0)
        .sort((a, b) => a.timeMs - b.timeMs);
    }
  }

  exportState(): PortfolioCircuitBreakerState {
    return {
      cooldownUntilMs: this.cooldownUntilMs,
      triggerCount: this.triggerCount,
      samples: [...this.samples],
    };
  }

  getTriggerCount(): number {
    return this.triggerCount;
  }

  /** Update rolling peak / cooldown; returns lot multiplier for new entries. */
  update(equity: number, timeMs: number): PortfolioCircuitBreakerUpdate {
    const safeEquity = Number.isFinite(equity) && equity > 0 ? equity : 0;
    const safeTime = Number.isFinite(timeMs) && timeMs > 0 ? timeMs : Date.now();
    if (safeEquity <= 0) {
      this.lastRawLotMultiplier = 1;
      return {
        lotMultiplier: 1,
        drawdownPercent: 0,
        rollingPeak: 0,
        triggered: false,
        inCooldown: safeTime < this.cooldownUntilMs,
        triggerCount: this.triggerCount,
      };
    }

    this.pushSample(safeTime, safeEquity);
    const rollingPeak = this.rollingPeak(safeTime);
    const dd = rollingPeak > 0
      ? Math.max(0, ((rollingPeak - safeEquity) / rollingPeak) * 100)
      : 0;

    const inCooldown = safeTime < this.cooldownUntilMs;
    let triggered = false;
    let lotMult = 1;

    if (inCooldown) {
      lotMult = this.config.lotMultiplier;
    } else if (dd >= this.config.ddTriggerPercent) {
      this.cooldownUntilMs = safeTime + this.config.pauseDays * MS_DAY;
      this.triggerCount += 1;
      triggered = true;
      lotMult = this.config.lotMultiplier;
    }

    this.lastRawLotMultiplier = lotMult;

    return {
      lotMultiplier: lotMult,
      drawdownPercent: dd,
      rollingPeak,
      triggered,
      inCooldown: inCooldown || triggered,
      triggerCount: this.triggerCount,
    };
  }

  private pushSample(timeMs: number, equity: number): void {
    const last = this.samples[this.samples.length - 1];
    if (last && last.timeMs === timeMs) {
      last.equity = Math.max(last.equity, equity);
      return;
    }
    this.samples.push({ timeMs, equity });
    const cutoff = timeMs - this.config.peakWindowDays * MS_DAY;
    while (this.samples.length > 0 && this.samples[0].timeMs < cutoff) {
      this.samples.shift();
    }
    // Cap memory for long backtests
    const maxSamples = 5000;
    if (this.samples.length > maxSamples) {
      const step = Math.ceil(this.samples.length / maxSamples);
      this.samples = this.samples.filter((_item, index) => index % step === 0 || index === this.samples.length - 1);
    }
  }

  private rollingPeak(timeMs: number): number {
    const cutoff = timeMs - this.config.peakWindowDays * MS_DAY;
    let peak = 0;
    for (const sample of this.samples) {
      if (sample.timeMs >= cutoff && sample.timeMs <= timeMs) {
        peak = Math.max(peak, sample.equity);
      }
    }
    return peak > 0 ? peak : (this.samples[this.samples.length - 1]?.equity ?? 0);
  }
}

/**
 * Cool-down when exchange min lot / qty step forces size above the hard
 * entry oversize cap (1.5× target). Without this, every auto-cycle re-runs
 * sizing + (for MRS2) openOrders/place attempts for instruments that can
 * never fit the account — API spam and last_error thrash.
 */

export const ENTRY_OVERSIZE_COOLDOWN_MS = 15 * 60 * 1000;
export const ENTRY_OVERSIZE_SKIP_ACTION = 'skip_min_lot_over_cap';
export const ENTRY_OVERSIZE_LOG_COOLDOWN_MS = 5 * 60 * 1000;

type CooldownEntry = {
  until: number;
  reason: string;
  oversize: number;
  targetNotional: number;
  actualNotional: number;
};

const cooldownByStrategy = new Map<string, CooldownEntry>();
const logCooldownUntil = new Map<string, number>();

const keyFor = (apiKeyName: string, strategyId: number): string => (
  `${String(apiKeyName || '').trim()}:${Number(strategyId) || 0}`
);

setInterval(() => {
  const now = Date.now();
  for (const [k, entry] of cooldownByStrategy) {
    if (entry.until <= now) {
      cooldownByStrategy.delete(k);
    }
  }
  for (const [k, until] of logCooldownUntil) {
    if (until <= now) {
      logCooldownUntil.delete(k);
    }
  }
}, 60_000).unref?.();

export const clearEntryOversizeCooldown = (
  apiKeyName?: string,
  strategyId?: number,
): void => {
  if (apiKeyName == null || strategyId == null) {
    cooldownByStrategy.clear();
    logCooldownUntil.clear();
    return;
  }
  const key = keyFor(apiKeyName, strategyId);
  cooldownByStrategy.delete(key);
  logCooldownUntil.delete(key);
};

export const isEntryOversizeCoolingDown = (
  apiKeyName: string,
  strategyId: number,
  now = Date.now(),
): { active: boolean; remainingMs: number; reason: string | null; entry: CooldownEntry | null } => {
  const key = keyFor(apiKeyName, strategyId);
  const entry = cooldownByStrategy.get(key) || null;
  if (!entry || entry.until <= now) {
    if (entry) {
      cooldownByStrategy.delete(key);
    }
    return { active: false, remainingMs: 0, reason: null, entry: null };
  }
  return {
    active: true,
    remainingMs: entry.until - now,
    reason: entry.reason,
    entry,
  };
};

export const markEntryOversizeBlocked = (
  apiKeyName: string,
  strategyId: number,
  args: {
    oversize: number;
    targetNotional: number;
    actualNotional: number;
    detail?: string;
  },
  now = Date.now(),
  cooldownMs = ENTRY_OVERSIZE_COOLDOWN_MS,
): CooldownEntry => {
  const reason = args.detail
    || (
      `min-lot oversize ${(args.oversize * 100).toFixed(1)}% above target `
      + `(target=${args.targetNotional.toFixed(2)}, actual=${args.actualNotional.toFixed(2)})`
    );
  const entry: CooldownEntry = {
    until: now + Math.max(1_000, cooldownMs),
    reason,
    oversize: args.oversize,
    targetNotional: args.targetNotional,
    actualNotional: args.actualNotional,
  };
  cooldownByStrategy.set(keyFor(apiKeyName, strategyId), entry);
  return entry;
};

/** Throttle error logs / runtime_events inserts while cool-down is active. */
export const shouldLogEntryOversizeBlock = (
  apiKeyName: string,
  strategyId: number,
  now = Date.now(),
): boolean => {
  const key = keyFor(apiKeyName, strategyId);
  const until = Number(logCooldownUntil.get(key) || 0);
  if (until > now) {
    return false;
  }
  logCooldownUntil.set(key, now + ENTRY_OVERSIZE_LOG_COOLDOWN_MS);
  return true;
};

/**
 * Pure decision for MRS2 resting sync / market entry after a qty plan is known.
 * Used by strategy.ts and unit tests.
 */
export type EntryOversizeGateDecision =
  | { action: 'allow' }
  | { action: 'skip_cooldown'; reason: string; remainingMs: number }
  | { action: 'block_oversize'; reason: string };

export const decideEntryOversizeGate = (args: {
  coolingDown: boolean;
  cooldownReason?: string | null;
  remainingMs?: number;
  oversize: number;
  maxOversizeFraction: number;
}): EntryOversizeGateDecision => {
  if (args.coolingDown) {
    return {
      action: 'skip_cooldown',
      reason: args.cooldownReason || ENTRY_OVERSIZE_SKIP_ACTION,
      remainingMs: Math.max(0, args.remainingMs || 0),
    };
  }
  if (Number(args.oversize) > Number(args.maxOversizeFraction)) {
    return {
      action: 'block_oversize',
      reason: ENTRY_OVERSIZE_SKIP_ACTION,
    };
  }
  return { action: 'allow' };
};

/**
 * Entry serialization locks for live strategy execution.
 * Extracted from bot/strategy.ts (move-only refactor).
 */

// ── Per-trading-system serialization mutex ──
// Prevents OP-limit race when several strategies of the same TS receive entry
// signals in parallel within a single auto-cycle.
const systemEntryMutex = new Map<number, Promise<void>>();

export const acquireSystemEntryLock = async (systemId: number): Promise<() => void> => {
  if (!Number.isFinite(systemId) || systemId <= 0) {
    return () => {};
  }
  const previous = systemEntryMutex.get(systemId) || Promise.resolve();
  let release: () => void = () => {};
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => tail);
  systemEntryMutex.set(systemId, chained);
  await previous;
  return () => {
    release();
    if (systemEntryMutex.get(systemId) === chained) {
      systemEntryMutex.delete(systemId);
    }
  };
};

// ── Per-(api_key, pair_key) entry mutex ──
// Cross-TS serialization so two strategies on the SAME api_key + same pair cannot
// both pass entry checks at once.
const apiKeyPairEntryMutex = new Map<string, Promise<void>>();

export const acquireApiKeyPairEntryLock = async (apiKeyName: string, pairKey: string): Promise<() => void> => {
  if (!apiKeyName || !pairKey) {
    return () => {};
  }
  const lockKey = `${apiKeyName}::${pairKey}`;
  const previous = apiKeyPairEntryMutex.get(lockKey) || Promise.resolve();
  let release: () => void = () => {};
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(() => tail);
  apiKeyPairEntryMutex.set(lockKey, chained);
  await previous;
  return () => {
    release();
    if (apiKeyPairEntryMutex.get(lockKey) === chained) {
      apiKeyPairEntryMutex.delete(lockKey);
    }
  };
};

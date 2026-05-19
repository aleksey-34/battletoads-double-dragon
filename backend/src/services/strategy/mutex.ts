// Strategy Mutex — prevents race conditions during concurrent strategy execution
// Extracted from bot/strategy.ts

const strategyLocks = new Map<string, Promise<void>>();

/**
 * Acquire a lock for a given strategy ID. If the strategy is already locked,
 * wait for the existing lock to release before acquiring.
 */
export async function acquireStrategyLock(strategyId: string): Promise<void> {
  while (strategyLocks.has(strategyId)) {
    await strategyLocks.get(strategyId)!;
  }

  let release: () => void;
  const lockPromise = new Promise<void>((resolve) => {
    release = resolve;
  });

  strategyLocks.set(strategyId, lockPromise);

  // Store release function on the promise for later use
  (lockPromise as any).__release = release!;
}

/**
 * Release the lock for the given strategy ID.
 */
export function releaseStrategyLock(strategyId: string): void {
  const lock = strategyLocks.get(strategyId);
  if (lock) {
    strategyLocks.delete(strategyId);
    const release = (lock as any).__release;
    if (release) release();
  }
}

/**
 * Check if a strategy is currently locked.
 */
export function isStrategyLocked(strategyId: string): boolean {
  return strategyLocks.has(strategyId);
}

/**
 * Execute a function with a lock on the strategy.
 * Automatically acquires before execution and releases after (or on error).
 */
export async function withStrategyLock<T>(
  strategyId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await acquireStrategyLock(strategyId);
  try {
    return await fn();
  } finally {
    releaseStrategyLock(strategyId);
  }
}

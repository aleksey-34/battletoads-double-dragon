const POSITION_TTL_WEEX_MS = 30_000;
const POSITION_TTL_DEFAULT_MS = 12_000;
const STALE_SERVE_MAX_AGE_MS = 120_000;

type PositionCacheEntry = {
  data: any[];
  fetchedAt: number;
};

const positionCache = new Map<string, PositionCacheEntry>();
const positionInflight = new Map<string, Promise<any[]>>();

/** Global WEEX position queue — serializes polls to respect IP rate budget. */
const weexPositionQueue = (() => {
  let chain: Promise<void> = Promise.resolve();
  return (fn: () => Promise<void>): Promise<void> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => undefined);
    return next;
  };
})();

const cacheKeyFor = (apiKeyName: string, symbol?: string): string => (
  `${apiKeyName}:${String(symbol || '*').toUpperCase()}`
);

const ttlForExchange = (exchange: string): number => (
  exchange === 'weex' ? POSITION_TTL_WEEX_MS : POSITION_TTL_DEFAULT_MS
);

const isRateLimitMessage = (message: string): boolean => {
  const m = message.toLowerCase();
  return m.includes('429')
    || m.includes('rate limit')
    || m.includes('too much request weight')
    || m.includes('too many requests');
};

/** Drop cached positions after place/close so post-open validation does not see a stale empty snapshot. */
export const invalidatePositionCache = (apiKeyName: string, symbol?: string): void => {
  const safe = String(apiKeyName || '').trim();
  if (!safe) {
    return;
  }
  if (symbol) {
    positionCache.delete(cacheKeyFor(safe, symbol));
    positionCache.delete(cacheKeyFor(safe, undefined));
    positionInflight.delete(cacheKeyFor(safe, symbol));
    positionInflight.delete(cacheKeyFor(safe, undefined));
    return;
  }
  const prefix = `${safe}:`;
  for (const key of [...positionCache.keys()]) {
    if (key.startsWith(prefix)) {
      positionCache.delete(key);
    }
  }
  for (const key of [...positionInflight.keys()]) {
    if (key.startsWith(prefix)) {
      positionInflight.delete(key);
    }
  }
};

export const getCachedPositions = async (
  apiKeyName: string,
  symbol: string | undefined,
  exchangeRaw: string,
  fetcher: () => Promise<any[]>,
  options?: { forceRefresh?: boolean },
): Promise<any[]> => {
  const exchange = String(exchangeRaw || '').toLowerCase();
  const key = cacheKeyFor(apiKeyName, symbol);
  const ttl = ttlForExchange(exchange);
  const cached = positionCache.get(key);
  const now = Date.now();

  if (!options?.forceRefresh && cached && now - cached.fetchedAt < ttl) {
    return cached.data;
  }

  const inflight = positionInflight.get(key);
  if (inflight) {
    return inflight;
  }

  const runFetch = async (): Promise<any[]> => {
    try {
      const data = await fetcher();
      const arr = Array.isArray(data) ? data : [];
      positionCache.set(key, { data: arr, fetchedAt: Date.now() });
      return arr;
    } catch (error) {
      const msg = String((error as Error)?.message || error || '');
      if (cached && isRateLimitMessage(msg) && now - cached.fetchedAt < STALE_SERVE_MAX_AGE_MS) {
        return cached.data;
      }
      throw error;
    } finally {
      positionInflight.delete(key);
    }
  };

  const promise = exchange === 'weex'
    ? new Promise<any[]>((resolve, reject) => {
      void weexPositionQueue(async () => {
        try {
          resolve(await runFetch());
        } catch (error) {
          reject(error);
        }
      });
    })
    : runFetch();

  positionInflight.set(key, promise);
  return promise;
};

/** Sequential position poll for many WEEX keys (monitoring / admin). */
export const batchPositionsSequential = async (
  apiKeyNames: string[],
  fetcher: (apiKeyName: string) => Promise<any[]>,
  gapMs = 600,
): Promise<Array<{ apiKeyName: string; positions: any[]; error?: string }>> => {
  const out: Array<{ apiKeyName: string; positions: any[]; error?: string }> = [];
  for (const name of apiKeyNames) {
    try {
      const positions = await fetcher(name);
      out.push({ apiKeyName: name, positions });
    } catch (error) {
      out.push({
        apiKeyName: name,
        positions: [],
        error: String((error as Error)?.message || error || 'unknown'),
      });
    }
    if (gapMs > 0) {
      await new Promise((r) => setTimeout(r, gapMs));
    }
  }
  return out;
};

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of positionCache) {
    if (now - v.fetchedAt > STALE_SERVE_MAX_AGE_MS) {
      positionCache.delete(k);
    }
  }
}, 60_000);

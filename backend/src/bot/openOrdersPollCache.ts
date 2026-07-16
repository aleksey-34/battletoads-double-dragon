/**
 * Short-TTL open-orders snapshot cache.
 * Dense mono MRS2 books call getOpenOrders(symbol) once per strategy per cycle;
 * without reuse that is O(N) exchange calls on the same API key. Prefer one
 * account-wide fetch, then filter by symbol for siblings within the TTL window.
 */

const OPEN_ORDERS_TTL_MS = 12_000;
const STALE_SERVE_MAX_AGE_MS = 60_000;

type CacheEntry = {
  data: any[];
  fetchedAt: number;
};

const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<any[]>>();

const allKey = (apiKeyName: string): string => `${String(apiKeyName || '').trim()}:*`;
const symKey = (apiKeyName: string, symbol: string): string => (
  `${String(apiKeyName || '').trim()}:${String(symbol || '').toUpperCase()}`
);

/** Match exchange.toUiSymbol: strip settle suffix after `:`, drop `/`, keep alnum. */
const normalizeUiSymbol = (value: unknown): string => {
  const raw = String(value || '').toUpperCase();
  const beforeColon = raw.split(':')[0];
  return beforeColon.replace(/[^A-Z0-9]/g, '');
};

export const filterOpenOrdersBySymbol = (orders: any[], symbol: string): any[] => {
  const want = normalizeUiSymbol(symbol);
  if (!want) {
    return Array.isArray(orders) ? orders : [];
  }
  return (Array.isArray(orders) ? orders : []).filter((order) => {
    const orderSym = normalizeUiSymbol(order?.symbol ?? order?.info?.symbol ?? '');
    return orderSym === want;
  });
};

export const invalidateOpenOrdersCache = (apiKeyName: string, symbol?: string): void => {
  const safe = String(apiKeyName || '').trim();
  if (!safe) {
    return;
  }
  cache.delete(allKey(safe));
  inflight.delete(allKey(safe));
  if (symbol) {
    cache.delete(symKey(safe, symbol));
    inflight.delete(symKey(safe, symbol));
    return;
  }
  const prefix = `${safe}:`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) {
      cache.delete(key);
    }
  }
  for (const key of [...inflight.keys()]) {
    if (key.startsWith(prefix)) {
      inflight.delete(key);
    }
  }
};

export const clearOpenOrdersCacheForTests = (): void => {
  cache.clear();
  inflight.clear();
};

type FetchOpenOrders = (symbol?: string) => Promise<any[]>;

/**
 * Resolve open orders for optional symbol using account-wide cache when possible.
 * `fetchAll` should omit symbol (full book). `fetchSymbol` is fallback if all-book fails.
 */
export const getCachedOpenOrders = async (
  apiKeyName: string,
  symbol: string | undefined,
  fetchAll: FetchOpenOrders,
  fetchSymbol: FetchOpenOrders,
  options?: { forceRefresh?: boolean },
): Promise<any[]> => {
  const now = Date.now();
  const wantSymbol = symbol ? String(symbol).trim() : '';

  if (!options?.forceRefresh) {
    const allCached = cache.get(allKey(apiKeyName));
    if (allCached && now - allCached.fetchedAt < OPEN_ORDERS_TTL_MS) {
      return wantSymbol ? filterOpenOrdersBySymbol(allCached.data, wantSymbol) : allCached.data;
    }
    if (wantSymbol) {
      const one = cache.get(symKey(apiKeyName, wantSymbol));
      if (one && now - one.fetchedAt < OPEN_ORDERS_TTL_MS) {
        return one.data;
      }
    }
  }

  const preferAllKey = allKey(apiKeyName);
  const existingAll = inflight.get(preferAllKey);
  if (existingAll) {
    const data = await existingAll;
    return wantSymbol ? filterOpenOrdersBySymbol(data, wantSymbol) : data;
  }

  if (wantSymbol) {
    const existingSym = inflight.get(symKey(apiKeyName, wantSymbol));
    if (existingSym) {
      return existingSym;
    }
  }

  const runAll = async (): Promise<any[]> => {
    try {
      const data = await fetchAll(undefined);
      const arr = Array.isArray(data) ? data : [];
      cache.set(preferAllKey, { data: arr, fetchedAt: Date.now() });
      return arr;
    } catch (error) {
      const stale = cache.get(preferAllKey);
      const msg = String((error as Error)?.message || error || '').toLowerCase();
      const rateLimited = msg.includes('429') || msg.includes('rate limit') || msg.includes('too many');
      if (stale && rateLimited && now - stale.fetchedAt < STALE_SERVE_MAX_AGE_MS) {
        return stale.data;
      }
      throw error;
    } finally {
      inflight.delete(preferAllKey);
    }
  };

  // Prefer one account-wide fetch so sibling MRS2 symbols reuse the snapshot.
  const allPromise = runAll();
  inflight.set(preferAllKey, allPromise);

  try {
    const all = await allPromise;
    return wantSymbol ? filterOpenOrdersBySymbol(all, wantSymbol) : all;
  } catch (allError) {
    if (!wantSymbol) {
      throw allError;
    }
    // Fallback: per-symbol fetch (some venues reject symbol-less openOrders).
    const sKey = symKey(apiKeyName, wantSymbol);
    const runSym = async (): Promise<any[]> => {
      try {
        const data = await fetchSymbol(wantSymbol);
        const arr = Array.isArray(data) ? data : [];
        cache.set(sKey, { data: arr, fetchedAt: Date.now() });
        return arr;
      } finally {
        inflight.delete(sKey);
      }
    };
    const symPromise = runSym();
    inflight.set(sKey, symPromise);
    return symPromise;
  }
};

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of cache) {
    if (now - v.fetchedAt > STALE_SERVE_MAX_AGE_MS) {
      cache.delete(k);
    }
  }
}, 60_000).unref?.();

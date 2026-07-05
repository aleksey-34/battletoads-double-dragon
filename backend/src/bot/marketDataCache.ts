import { getExchangeForApiKey, getMarketData } from './exchange';

const CANDLE_CACHE_TTL_MS = 25_000;

interface CandleCacheEntry {
  data: any[];
  fetchedAt: number;
}

const candleAutoCache = new Map<string, CandleCacheEntry>();
const candleAutoInflight = new Map<string, Promise<any[]>>();
const relayKeysByExchange = new Map<string, string[]>();
const relayKeyCursor = new Map<string, number>();

type MarketDataOptions = {
  startMs?: number;
  endMs?: number;
};

export const registerMarketDataRelayKey = (exchange: string, apiKeyName: string): void => {
  const ex = String(exchange || '').trim().toLowerCase();
  const key = String(apiKeyName || '').trim();
  if (!ex || !key) return;
  const list = relayKeysByExchange.get(ex) || [];
  if (!list.includes(key)) {
    list.push(key);
    relayKeysByExchange.set(ex, list);
  }
};

const pickRelayApiKey = (exchange: string, preferredKey: string): string => {
  const ex = String(exchange || '').trim().toLowerCase();
  const list = relayKeysByExchange.get(ex) || [];
  if (list.length === 0) return preferredKey;
  if (list.length === 1) return list[0];
  const idx = relayKeyCursor.get(ex) || 0;
  const picked = list[idx % list.length];
  relayKeyCursor.set(ex, (idx + 1) % list.length);
  return picked;
};

const cacheKeyFor = (
  exchange: string,
  symbol: string,
  interval: string,
  limit: number,
): string => `${exchange}:${symbol}:${interval}:${limit}`;

export const getCachedMarketData = async (
  apiKeyName: string,
  symbol: string,
  interval: string,
  limit: number,
  options?: MarketDataOptions,
): Promise<any[]> => {
  if (options?.startMs || options?.endMs) {
    return getMarketData(apiKeyName, symbol, interval, limit, options);
  }

  const exchange = getExchangeForApiKey(apiKeyName) || `key:${apiKeyName}`;
  const key = cacheKeyFor(exchange, symbol, interval, limit);
  const cached = candleAutoCache.get(key);
  if (cached && Date.now() - cached.fetchedAt < CANDLE_CACHE_TTL_MS) {
    return cached.data;
  }

  const inflight = candleAutoInflight.get(key);
  if (inflight) {
    return inflight;
  }

  const relayKey = pickRelayApiKey(exchange, apiKeyName);
  const promise = (async () => {
    try {
      const data = await getMarketData(relayKey, symbol, interval, limit, options);
      const arr = Array.isArray(data) ? data : [];
      candleAutoCache.set(key, { data: arr, fetchedAt: Date.now() });
      return arr;
    } finally {
      candleAutoInflight.delete(key);
    }
  })();
  candleAutoInflight.set(key, promise);
  return promise;
};

export type MarketDataWarmupJob = {
  exchange: string;
  apiKeyName: string;
  symbol: string;
  interval: string;
  limit: number;
};

/** Sequential warm-up per exchange — one fetch at a time, exchange-scoped dedup. */
export const warmMarketDataCache = async (jobs: MarketDataWarmupJob[]): Promise<number> => {
  const seen = new Set<string>();
  const byExchange = new Map<string, MarketDataWarmupJob[]>();

  for (const job of jobs) {
    const ex = job.exchange || `key:${job.apiKeyName}`;
    const dedup = cacheKeyFor(ex, job.symbol, job.interval, job.limit);
    if (seen.has(dedup)) continue;
    seen.add(dedup);
    const list = byExchange.get(ex) || [];
    list.push(job);
    byExchange.set(ex, list);
  }

  let warmed = 0;
  for (const [exchange, list] of byExchange) {
    for (const job of list) {
      try {
        await getCachedMarketData(job.apiKeyName, job.symbol, job.interval, job.limit);
        warmed += 1;
      } catch {
        // strategy will retry; don't block cycle
      }
      // Small gap between symbols on rate-sensitive exchanges
      if (exchange === 'weex') {
        await new Promise((r) => setTimeout(r, 120));
      }
    }
  }
  return warmed;
};

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of candleAutoCache) {
    if (now - v.fetchedAt > CANDLE_CACHE_TTL_MS * 2) candleAutoCache.delete(k);
  }
}, 60_000);

const PUBLIC_PORTFOLIO_CACHE_TTL_MS = 3_600_000;

type CacheEntry = {
  expiresAt: number;
  payload: unknown;
};

const publicPortfolioCache = new Map<string, CacheEntry>();

export const getPublicPortfolioCacheTtlMs = (): number => PUBLIC_PORTFOLIO_CACHE_TTL_MS;

export const getPublicPortfolioCache = (cacheKey: string): CacheEntry | undefined => {
  const cached = publicPortfolioCache.get(cacheKey);
  if (!cached) {
    return undefined;
  }
  if (cached.expiresAt <= Date.now()) {
    publicPortfolioCache.delete(cacheKey);
    return undefined;
  }
  return cached;
};

export const setPublicPortfolioCache = (cacheKey: string, payload: unknown): void => {
  publicPortfolioCache.set(cacheKey, {
    expiresAt: Date.now() + PUBLIC_PORTFOLIO_CACHE_TTL_MS,
    payload,
  });
};

export const invalidatePublicPortfolioCacheForSlug = (slug: string): void => {
  const normalized = String(slug || '').trim().toLowerCase();
  if (!normalized) {
    return;
  }
  const prefix = `${normalized}|`;
  for (const key of [...publicPortfolioCache.keys()]) {
    if (key.startsWith(prefix)) {
      publicPortfolioCache.delete(key);
    }
  }
};

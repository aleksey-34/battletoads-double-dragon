const OFFLINE_SYMBOL_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const WEEX_COPY_STOCK_LOG_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const WEEX_DELIST_SKIP_LOG_COOLDOWN_MS = 6 * 60 * 60 * 1000;
const offlineSymbolLogCooldown = new Map<string, number>();
const weexCopyStockLogCooldown = new Map<string, number>();
const weexDelistSkipLogCooldown = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [k, until] of offlineSymbolLogCooldown) {
    if (until <= now) {
      offlineSymbolLogCooldown.delete(k);
    }
  }
}, 60_000);

export const isOfflineSymbolMarketDataError = (errorText: string): boolean => {
  const text = String(errorText || '').toLowerCase();
  return text.includes('market symbol offline on')
    || text.includes('symbol is offline on')
    || text.includes('not supported via the api')
    || text.includes('apitradingsymbols')
    || text.includes('contract not found')
    || /code["']?\s*[:=]\s*-?1058/.test(text)
    || /code["']?\s*[:=]\s*-?1054/.test(text)
    || (text.includes('offline currently') && (text.includes('validated symbols') || text.includes('validted')));
};

export const shouldLogOfflineSymbolSkip = (apiKeyName: string, strategyId: number): boolean => {
  const key = `${apiKeyName}:${strategyId}`;
  const now = Date.now();
  const until = Number(offlineSymbolLogCooldown.get(key) || 0);
  if (until > now) {
    return false;
  }
  offlineSymbolLogCooldown.set(key, now + OFFLINE_SYMBOL_LOG_COOLDOWN_MS);
  return true;
};

export const shouldLogWeexCopyStockSkip = (apiKeyName: string, symbol: string): boolean => {
  const key = `${apiKeyName}:${String(symbol || '').toUpperCase()}`;
  const now = Date.now();
  const until = Number(weexCopyStockLogCooldown.get(key) || 0);
  if (until > now) return false;
  weexCopyStockLogCooldown.set(key, now + WEEX_COPY_STOCK_LOG_COOLDOWN_MS);
  return true;
};

export const shouldLogWeexDelistSkip = (symbol: string): boolean => {
  const key = String(symbol || '').toUpperCase();
  const now = Date.now();
  const until = Number(weexDelistSkipLogCooldown.get(key) || 0);
  if (until > now) return false;
  weexDelistSkipLogCooldown.set(key, now + WEEX_DELIST_SKIP_LOG_COOLDOWN_MS);
  return true;
};

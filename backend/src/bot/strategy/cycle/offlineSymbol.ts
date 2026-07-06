const OFFLINE_SYMBOL_LOG_COOLDOWN_MS = 5 * 60 * 1000;
const offlineSymbolLogCooldown = new Map<string, number>();

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

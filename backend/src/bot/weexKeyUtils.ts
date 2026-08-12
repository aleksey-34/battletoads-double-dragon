/** WEEX equity-perp universe used in hamfive stocks ZZ sleeve. */
export const WEEX_STOCK_SYMBOLS = new Set([
  'AMZNUSDT',
  'AVGOUSDT',
  'BABAUSDT',
  'IBMUSDT',
  'INTCUSDT',
  'MUUSDT',
  'NVDAUSDT',
  'RIVNUSDT',
  'SOXLUSDT',
  'SPXUSDT',
  'TSLAUSDT',
  'UBERUSDT',
]);

/** SPXUSDT on WEEX is SPX6900 memecoin (~$0.3), not S&P500. */
export const WEEX_COPY_STOCK_SYMBOL = 'SPXUSDT';

export const normalizeWeexSymbolKey = (symbol: string): string =>
  String(symbol || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

export const isWeexStockSymbol = (symbol: string): boolean =>
  WEEX_STOCK_SYMBOLS.has(normalizeWeexSymbolKey(symbol));

/** Elite / copy-trading follower keys — per-key product limits, not global delist. */
export const isWeexCopyLikeKey = (apiKeyName: string): boolean => {
  const n = String(apiKeyName || '').trim().toLowerCase();
  if (!n) return false;
  if (n.startsWith('copy_')) return true;
  if (n.startsWith('arcopy')) return true;
  if (n.startsWith('icopy')) return true;
  if (n.includes('dup_hidden')) return true;
  return false;
};

/** Copy Elite can trade SPX only among the stocks sleeve. Personal keys may use all 12. */
export const isWeexCopyBlockedStock = (apiKeyName: string, symbol: string): boolean => {
  if (!isWeexCopyLikeKey(apiKeyName)) return false;
  const sym = normalizeWeexSymbolKey(symbol);
  if (!isWeexStockSymbol(sym)) return false;
  return sym !== WEEX_COPY_STOCK_SYMBOL;
};

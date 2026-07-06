import { closePosition, getPositions } from '../../exchange';

export const normalizeExchangeSymbolKey = (raw: string): string => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) {
    return '';
  }
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

export const countExchangeOpenPositions = (positions: any[]): number => {
  const symbols = new Set<string>();
  for (const row of positions || []) {
    const size = Math.abs(Number(row?.size || 0));
    if (!Number.isFinite(size) || size <= 0) {
      continue;
    }
    const key = normalizeExchangeSymbolKey(String(row?.symbol || ''));
    if (key) {
      symbols.add(key);
    }
  }
  return symbols.size;
};

export const closeAllForSymbol = async (apiKeyName: string, symbol: string, options?: { marketType?: 'spot' | 'swap' }): Promise<void> => {
  const positions = await getPositions(apiKeyName, symbol);
  const relevant = positions.filter((position: any) => {
    return (
      String(position?.symbol || '').toUpperCase() === symbol.toUpperCase() &&
      Number.parseFloat(String(position?.size || '0')) > 0
    );
  });

  for (const position of relevant) {
    await closePosition(apiKeyName, symbol, String(position.size), position.side as 'Buy' | 'Sell', options);
  }
};

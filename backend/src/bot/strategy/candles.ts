import { Strategy } from '../../config/settings';
import { getMarketData } from '../exchange';
import { calculateSyntheticOHLC } from '../synthetic';
import { getCachedMarketData } from '../marketDataCache';
import type { ParsedSyntheticCandle } from './types';
import { normalizeMarketMode } from './normalize';

export const parseSyntheticCandle = (item: any): ParsedSyntheticCandle | null => {
  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

export const parseMarketDataCandle = (item: any): ParsedSyntheticCandle | null => {
  if (!Array.isArray(item) || item.length < 5) {
    return null;
  }

  const timeMs = Number(item[0]);
  const open = Number(item[1]);
  const high = Number(item[2]);
  const low = Number(item[3]);
  const close = Number(item[4]);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

export const loadStrategyCandles = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'base_coef' | 'quote_coef' | 'interval'>,
  limit: number,
  options?: {
    startMs?: number;
    endMs?: number;
  }
): Promise<ParsedSyntheticCandle[]> => {
  const marketMode = normalizeMarketMode(strategy.market_mode);

  if (marketMode === 'mono') {
    const raw = await getCachedMarketData(
      apiKeyName,
      strategy.base_symbol,
      strategy.interval,
      limit,
      options
    );

    return (Array.isArray(raw) ? raw : [])
      .map((item) => parseMarketDataCandle(item))
      .filter((item): item is ParsedSyntheticCandle => !!item)
      .sort((a, b) => a.timeMs - b.timeMs);
  }

  const raw = await calculateSyntheticOHLC(
    apiKeyName,
    strategy.base_symbol,
    strategy.quote_symbol,
    strategy.base_coef,
    strategy.quote_coef,
    strategy.interval,
    limit,
    options
  );

  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseSyntheticCandle(item))
    .filter((item): item is ParsedSyntheticCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

export const getLatestMarketClose = async (apiKeyName: string, symbol: string): Promise<number> => {
  const payload = await getMarketData(apiKeyName, symbol, '1m', 5);
  const parsed = (Array.isArray(payload) ? payload : [])
    .map((item: any) => {
      if (!Array.isArray(item) || item.length < 5) {
        return null;
      }
      const timeMs = Number(item[0]);
      const close = Number(item[4]);
      if (!Number.isFinite(timeMs) || !Number.isFinite(close)) {
        return null;
      }
      return { timeMs, close };
    })
    .filter((item): item is { timeMs: number; close: number } => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);

  const latest = parsed[parsed.length - 1];
  if (!latest) {
    throw new Error(`No market data for ${symbol}`);
  }

  return latest.close;
};

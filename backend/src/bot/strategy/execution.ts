import { Strategy } from '../../config/settings';
import { cancelAllOrders, getPositions, invalidatePositionCache } from '../exchange';
import logger from '../../utils/logger';
import { getStrategySymbols, intervalToMs } from './normalize';
import { closeAllForSymbol } from './cycle/positionGuards';
import type { ExecutionCandleContext, ParsedSyntheticCandle } from './types';

export const RESYNC_CONFIRM_MS = 90_000;
export interface PendingFlatEntry { firstDetectedMs: number; lastRatio: number; }
export const resyncPendingFlatByStrategy = new Map<number, PendingFlatEntry>();

export const BAR_CLOSE_FRESHNESS_MS = 1500;
export const TRAILING_RATIO_EPSILON = 1e-12;

export const processedClosedBarByStrategy = new Map<string, number>();

export const partialTpTriggeredByStrategy = new Map<number, boolean>();

const sleepMs = async (ms: number): Promise<void> => {
  await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, ms)));
};

export const loadPairPositionsForValidation = async (
  apiKeyName: string,
  baseSymbol: string,
  quoteSymbol: string,
  attempts: number = 5,
  waitMs: number = 500
): Promise<{ basePosition: any | null; quotePosition: any | null }> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  invalidatePositionCache(apiKeyName);

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName, undefined, { forceRefresh: attempt === 0 });

    const basePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === baseSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    const quotePosition = positions.find((position: any) => {
      return (
        String(position?.symbol || '').toUpperCase() === quoteSymbol.toUpperCase()
        && Number.parseFloat(String(position?.size || '0')) > 0
      );
    }) || null;

    if (basePosition && quotePosition) {
      return { basePosition, quotePosition };
    }

    if (attempt < safeAttempts - 1) {
      invalidatePositionCache(apiKeyName);
      await sleepMs(waitMs);
    }
  }

  return {
    basePosition: null,
    quotePosition: null,
  };
};

export const loadSinglePositionForValidation = async (
  apiKeyName: string,
  symbol: string,
  attempts: number = 5,
  waitMs: number = 500
): Promise<any | null> => {
  const safeAttempts = Math.max(1, Math.floor(attempts));
  invalidatePositionCache(apiKeyName);

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName, undefined, { forceRefresh: attempt === 0 });
    const position = positions.find((item: any) => {
      return (
        String(item?.symbol || '').toUpperCase() === symbol.toUpperCase()
        && Number.parseFloat(String(item?.size || '0')) > 0
      );
    }) || null;

    if (position) {
      return position;
    }

    if (attempt < safeAttempts - 1) {
      invalidatePositionCache(apiKeyName);
      await sleepMs(waitMs);
    }
  }

  return null;
};

export const resolveExecutionCandleContext = (
  candles: ParsedSyntheticCandle[],
  interval: string,
  closedBarOnly: boolean
): ExecutionCandleContext => {
  if (!Array.isArray(candles) || candles.length === 0) {
    throw new Error('No synthetic candles available for execution');
  }

  if (!closedBarOnly) {
    const latest = candles[candles.length - 1];
    return {
      candlesForSignal: candles,
      evaluatedBarTimeMs: latest.timeMs,
    };
  }

  const intervalMs = Math.max(60 * 1000, intervalToMs(interval));
  let closedIndex = candles.length - 1;
  const latest = candles[closedIndex];
  const latestClosesAt = latest.timeMs + intervalMs;

  if (latestClosesAt > Date.now() + BAR_CLOSE_FRESHNESS_MS) {
    closedIndex -= 1;
  }

  if (closedIndex < 0) {
    throw new Error('No closed candles available for execution');
  }

  return {
    candlesForSignal: candles.slice(0, closedIndex + 1),
    evaluatedBarTimeMs: candles[closedIndex].timeMs,
  };
};

export const hasOpenSiblingsForSymbol = async (
  apiKeyName: string,
  symbol: string,
  strategyId: number,
): Promise<boolean> => {
  if (!apiKeyName || !symbol || !Number.isFinite(strategyId)) {
    return false;
  }
  try {
    const { db } = await import('../../utils/database');
    const apiKeyRow: any = await db.get(`SELECT id FROM api_keys WHERE name = ?`, [apiKeyName]);
    if (!apiKeyRow?.id) {
      return false;
    }
    const row: any = await db.get(
      `SELECT COUNT(*) AS cnt FROM strategies
       WHERE api_key_id = ?
         AND is_active = 1
         AND state != 'flat'
         AND id != ?
         AND (UPPER(base_symbol) = UPPER(?) OR UPPER(quote_symbol) = UPPER(?))`,
      [apiKeyRow.id, strategyId, symbol, symbol],
    );
    return (row?.cnt || 0) > 0;
  } catch (err) {
    logger.warn(`hasOpenSiblingsForSymbol(${apiKeyName}, ${symbol}) failed: ${(err as Error).message}`);
    return false;
  }
};

export const closeStrategyExposure = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'id' | 'market_mode' | 'base_symbol' | 'quote_symbol' | 'market_type'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  const exchangeMarketType: 'spot' | 'swap' | undefined = strategy.market_type === 'spot' ? 'spot' : undefined;
  for (const symbol of symbols) {
    const strategyId = Number((strategy as { id?: number }).id);
    if (Number.isFinite(strategyId) && strategyId > 0) {
      const siblings = await hasOpenSiblingsForSymbol(apiKeyName, symbol, strategyId);
      if (siblings) {
        logger.info(
          `closeStrategyExposure: skipping exchange close for ${apiKeyName}/${symbol} — `
          + `sibling strategies still hold the shared position (strategy=${strategyId})`
        );
        continue;
      }
    }
    await closeAllForSymbol(apiKeyName, symbol, exchangeMarketType ? { marketType: exchangeMarketType } : undefined);
  }
};

export const cancelStrategyWorkingOrders = async (
  apiKeyName: string,
  strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>
): Promise<void> => {
  const symbols = getStrategySymbols(strategy);
  for (const symbol of symbols) {
    await cancelAllOrders(apiKeyName, symbol);
  }
};

export const inferMonoStateFromPosition = (
  position: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!position) {
    return 'flat';
  }

  const side = String(position?.side || '').toLowerCase();
  if (side === 'buy') {
    return 'long';
  }
  if (side === 'sell') {
    return 'short';
  }
  return 'mixed';
};

export const inferSyntheticStateFromPair = (
  basePosition: any | null,
  quotePosition: any | null
): 'flat' | 'long' | 'short' | 'mixed' => {
  if (!basePosition && !quotePosition) {
    return 'flat';
  }

  if (!basePosition || !quotePosition) {
    return 'mixed';
  }

  const baseSide = String(basePosition?.side || '').toLowerCase();
  const quoteSide = String(quotePosition?.side || '').toLowerCase();

  if (baseSide === 'buy' && quoteSide === 'sell') {
    return 'long';
  }

  if (baseSide === 'sell' && quoteSide === 'buy') {
    return 'short';
  }

  return 'mixed';
};

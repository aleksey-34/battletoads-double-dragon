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

export {
  processedClosedBarByStrategy,
  closedBarDedupeKey,
  clearProcessedClosedBarMemory,
  hydrateProcessedClosedBarMemory,
  rememberProcessedClosedBar,
  isClosedBarAlreadyProcessed,
} from './closedBarDedupe';

/** Monotonic persist — never rewind if a newer bar was already stored.
 * Success = exclusive claim (`changes > 0`). If another worker already claimed
 * this bar (or a newer one), return false so callers fail-closed and skip trade.
 */
export const persistProcessedClosedBar = async (strategyId: number, barTimeMs: number): Promise<boolean> => {
  const id = Number(strategyId);
  const n = Number(barTimeMs) || 0;
  if (!Number.isFinite(id) || id <= 0 || n <= 0) return false;
  try {
    const { db } = await import('../../utils/database');
    const result = await db.run(
      `UPDATE strategies
       SET last_processed_bar_ms = ?
       WHERE id = ?
         AND COALESCE(last_processed_bar_ms, 0) < ?`,
      [n, id, n],
    );
    return Number((result as { changes?: number })?.changes || 0) > 0;
  } catch (error) {
    logger.warn(`persistProcessedClosedBar failed for ${id}: ${(error as Error).message}`);
    return false;
  }
};

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
  let lastBase: any | null = null;
  let lastQuote: any | null = null;

  for (let attempt = 0; attempt < safeAttempts; attempt += 1) {
    const positions = await getPositions(apiKeyName, undefined, { forceRefresh: true });

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

    if (basePosition) lastBase = basePosition;
    if (quotePosition) lastQuote = quotePosition;

    if (lastBase && lastQuote) {
      return { basePosition: lastBase, quotePosition: lastQuote };
    }

    if (attempt < safeAttempts - 1) {
      invalidatePositionCache(apiKeyName);
      await sleepMs(waitMs);
    }
  }

  return {
    basePosition: lastBase,
    quotePosition: lastQuote,
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

  const intervalMs = intervalToMs(interval);
  if (!Number.isFinite(intervalMs) || intervalMs < 60 * 1000) {
    throw new Error(`Invalid strategy interval for closed-bar execution: ${interval}`);
  }
  const now = Date.now();
  let closedIndex = candles.length - 1;
  while (closedIndex >= 0) {
    const barOpen = Number(candles[closedIndex].timeMs) || 0;
    // Require now >= barOpen + intervalMs. Do not treat a forming 4h bar as closed after 1h.
    if (now >= barOpen + intervalMs) {
      break;
    }
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

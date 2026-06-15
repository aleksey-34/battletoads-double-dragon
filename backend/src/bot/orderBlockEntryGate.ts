import { db } from '../utils/database';
import { getMarketData } from './exchange';
import logger from '../utils/logger';
import {
  DEFAULT_ORDER_BLOCK_ENTRY_GATE,
  normalizeOrderBlockEntryGate,
  passesOrderBlockEntryGate,
  type OrderBlockEntryGate,
} from './orderBlockLiquidity';

export { DEFAULT_ORDER_BLOCK_ENTRY_GATE, type OrderBlockEntryGate };

type ParsedCandle = { timeMs: number; open: number; high: number; low: number; close: number };

type CardGateCacheEntry = {
  gate: OrderBlockEntryGate | null;
  expiresAtMs: number;
};

const cardGateCache = new Map<string, CardGateCacheEntry>();
const CACHE_TTL_MS = 60_000;

const parseCandle = (raw: unknown): ParsedCandle | null => {
  if (!raw || typeof raw !== 'object') return null;
  const row = raw as Record<string, unknown>;
  const timeMs = Number(row.time ?? row.timestamp ?? row.openTime ?? 0);
  const close = Number(row.close ?? 0);
  if (!Number.isFinite(timeMs) || !Number.isFinite(close) || close <= 0) return null;
  return {
    timeMs,
    open: Number(row.open ?? close),
    high: Number(row.high ?? close),
    low: Number(row.low ?? close),
    close,
  };
};

const parseGateFromMeta = (meta: Record<string, unknown>): OrderBlockEntryGate | null => {
  if (meta.orderBlockEntryGate && typeof meta.orderBlockEntryGate === 'object') {
    return normalizeOrderBlockEntryGate(meta.orderBlockEntryGate);
  }
  if (meta.btcLiquidityGate === true) {
    return DEFAULT_ORDER_BLOCK_ENTRY_GATE;
  }
  return null;
};

export const getOrderBlockEntryGateForApiKey = async (apiKeyName: string): Promise<OrderBlockEntryGate | null> => {
  const key = String(apiKeyName || '').trim();
  if (!key) return null;
  const cached = cardGateCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.gate;
  }

  let gate: OrderBlockEntryGate | null = null;
  try {
    const row = await db.get<{ published_system_name?: string }>(
      `SELECT published_system_name FROM algofund_profiles
       WHERE TRIM(COALESCE(execution_api_key_name, assigned_api_key_name, '')) = ?
       LIMIT 1`,
      [key],
    );
    const systemName = String(row?.published_system_name || '').trim();
    if (systemName) {
      const card = await db.get<{ metadata_json?: string }>(
        `SELECT metadata_json FROM master_cards
         WHERE code = ? AND is_active = 1
         LIMIT 1`,
        [`CARD::${systemName.toUpperCase()}`],
      );
      if (card?.metadata_json) {
        const meta = JSON.parse(String(card.metadata_json)) as Record<string, unknown>;
        gate = parseGateFromMeta(meta);
      }
    }
  } catch (error) {
    logger.warn(`[orderBlockEntryGate] card lookup failed for ${key}: ${(error as Error).message}`);
  }

  cardGateCache.set(key, { gate, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return gate;
};

const loadCandles = async (
  apiKeyName: string,
  symbol: string,
  interval: string,
  limit: number,
): Promise<ParsedCandle[]> => {
  const raw = await getMarketData(apiKeyName, symbol, interval, limit, {}).catch(() => []);
  return (Array.isArray(raw) ? raw : [])
    .map((item) => parseCandle(item))
    .filter((item): item is ParsedCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);
};

export const passesOrderBlockEntryGateLive = async (
  apiKeyName: string,
  side: 'long' | 'short',
  selfSymbol: string,
  gate: OrderBlockEntryGate = DEFAULT_ORDER_BLOCK_ENTRY_GATE,
): Promise<boolean> => {
  const gateInterval = String(gate.gateInterval || '4h').trim() || '4h';
  const symbol = gate.useSelf
    ? String(selfSymbol || '').trim().toUpperCase()
    : String(gate.anchorSymbol || 'BTCUSDT').trim().toUpperCase();
  if (!symbol) return true;
  const candles = await loadCandles(apiKeyName, symbol, gateInterval, 200);
  if (candles.length < 30) return true;
  return passesOrderBlockEntryGate(gate, side, candles, candles.length - 1);
};

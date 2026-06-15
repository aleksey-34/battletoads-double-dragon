import { db } from '../utils/database';
import { getMarketData } from './exchange';
import logger from '../utils/logger';
import type { StatArbEntryGate } from '../backtest/engine';
import { DEFAULT_STAT_ARB_ENTRY_GATE } from '../backtest/engine';

export { DEFAULT_STAT_ARB_ENTRY_GATE };

type ParsedCandle = { timeMs: number; open: number; high: number; low: number; close: number };

type CardGateCacheEntry = {
  gate: StatArbEntryGate | null;
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

const isBearishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotHigh = candles[index].high;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].high >= pivotHigh) return false;
    if (candles[index + offset].high >= pivotHigh) return false;
  }
  return true;
};

const isBullishFractalAt = (candles: ParsedCandle[], index: number, wings: number): boolean => {
  if (index < wings || index + wings >= candles.length) return false;
  const pivotLow = candles[index].low;
  for (let offset = 1; offset <= wings; offset += 1) {
    if (candles[index - offset].low <= pivotLow) return false;
    if (candles[index + offset].low <= pivotLow) return false;
  }
  return true;
};

const hasConfirmedBearishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBearishFractalAt(candles, pivotIndex, wings);
};

const hasConfirmedBullishFractal = (candles: ParsedCandle[], candleIndex: number, wings: number): boolean => {
  const pivotIndex = candleIndex - wings;
  return pivotIndex >= wings && isBullishFractalAt(candles, pivotIndex, wings);
};

const hasRecentConfirmedFractal = (
  candles: ParsedCandle[],
  candleIndex: number,
  wings: number,
  lookbackBars: number,
  kind: 'bullish' | 'bearish',
): boolean => {
  const start = Math.max(wings * 2, candleIndex - lookbackBars);
  for (let idx = candleIndex; idx >= start; idx -= 1) {
    if (kind === 'bullish' && hasConfirmedBullishFractal(candles, idx, wings)) return true;
    if (kind === 'bearish' && hasConfirmedBearishFractal(candles, idx, wings)) return true;
  }
  return false;
};

const computeRsiAtIndex = (closes: number[], endIndex: number, period: number): number | null => {
  if (endIndex < period || closes.length <= endIndex) return null;
  let gains = 0;
  let losses = 0;
  for (let i = endIndex - period + 1; i <= endIndex; i += 1) {
    const delta = closes[i] - closes[i - 1];
    if (delta >= 0) gains += delta;
    else losses -= delta;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss <= 0) return 100;
  return 100 - (100 / (1 + avgGain / avgLoss));
};

const passesGate = (
  gate: StatArbEntryGate,
  side: 'long' | 'short',
  candles: ParsedCandle[],
): boolean => {
  if (candles.length < 20) return false;
  const idx = candles.length - 1;
  const wings = Math.max(1, Math.floor(gate.fractalWings ?? 2));
  const lookback = Math.max(4, Math.floor(gate.lookbackBars ?? 24));
  const period = Math.max(2, Math.floor(gate.rsiPeriod ?? 14));
  const hasFractal = side === 'long'
    ? gate.longRequireBullishFractal === true
    : gate.shortRequireBearishFractal === true;
  const hasRsi = side === 'long'
    ? gate.longRsiBelow != null
    : gate.shortRsiAbove != null;
  const fractalHit = hasFractal
    ? hasRecentConfirmedFractal(
      candles,
      idx,
      wings,
      lookback,
      side === 'long' ? 'bullish' : 'bearish',
    )
    : false;
  const rsi = hasRsi ? computeRsiAtIndex(candles.map((c) => c.close), idx, period) : null;
  const rsiHit = hasRsi && rsi != null
    ? (side === 'long'
      ? rsi <= (gate.longRsiBelow as number)
      : rsi >= (gate.shortRsiAbove as number))
    : false;
  if (hasFractal && hasRsi) {
    return gate.combineWith === 'or' ? (fractalHit || rsiHit) : (fractalHit && rsiHit);
  }
  if (hasFractal) return fractalHit;
  return rsiHit;
};

const parseGateFromMeta = (meta: Record<string, unknown>): StatArbEntryGate | null => {
  if (meta.statArbEntryGate && typeof meta.statArbEntryGate === 'object') {
    return meta.statArbEntryGate as StatArbEntryGate;
  }
  if (meta.statArbFractalEntry === true) {
    return DEFAULT_STAT_ARB_ENTRY_GATE;
  }
  return null;
};

export const getStatArbEntryGateForApiKey = async (apiKeyName: string): Promise<StatArbEntryGate | null> => {
  const key = String(apiKeyName || '').trim();
  if (!key) return null;
  const cached = cardGateCache.get(key);
  if (cached && cached.expiresAtMs > Date.now()) {
    return cached.gate;
  }

  let gate: StatArbEntryGate | null = null;
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
    logger.warn(`[statArbEntryGate] card lookup failed for ${key}: ${(error as Error).message}`);
  }

  cardGateCache.set(key, { gate, expiresAtMs: Date.now() + CACHE_TTL_MS });
  return gate;
};

export const passesStatArbEntryGateLive = async (
  apiKeyName: string,
  baseSymbol: string,
  side: 'long' | 'short',
  gate: StatArbEntryGate = DEFAULT_STAT_ARB_ENTRY_GATE,
): Promise<boolean> => {
  const gateInterval = String(gate.gateInterval || '4h').trim() || '4h';
  const symbol = String(gate.anchorSymbol || baseSymbol || '').trim().toUpperCase();
  if (!symbol) return true;
  const candles = await loadCandles(apiKeyName, symbol, gateInterval, 160);
  return passesGate(gate, side, candles);
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

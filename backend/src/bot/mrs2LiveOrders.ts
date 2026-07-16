/**
 * Live resting limit sync for mono MRS2 (hamster sticky post_only entries).
 * Synthetic MRS2 must NOT use this path — only market legs.
 */
import logger from '../utils/logger';
import {
  cancelOrderById,
  getOpenOrders,
  placeOrder,
} from './exchange';
import type { Mrs2PendingLimits } from './mrs2Signal';
import { serializeMrs2PendingLimits } from './mrs2Signal';

export type Mrs2PendingWithOrders = Mrs2PendingLimits & {
  longOrderId?: string | null;
  shortOrderId?: string | null;
};

const PRICE_EPS_PCT = 0.05; // 0.05% — ignore tiny MA drift for cancel/replace

const asOrderId = (order: any): string | null => {
  const id = order?.id ?? order?.orderId ?? order?.info?.orderId ?? order?.info?.order_id;
  const s = id == null ? '' : String(id).trim();
  return s || null;
};

const priceChanged = (a: number | null | undefined, b: number | null | undefined): boolean => {
  if (a == null || b == null || !(a > 0) || !(b > 0)) return a !== b;
  return Math.abs(a - b) / a * 100 >= PRICE_EPS_PCT;
};

export const parseMrs2PendingWithOrders = (raw: unknown): Mrs2PendingWithOrders | null => {
  if (raw == null) return null;
  let obj: any = raw;
  if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s || s === '{}') return null;
    try { obj = JSON.parse(s); } catch { return null; }
  }
  if (!obj || typeof obj !== 'object') return null;
  const long = Number(obj.long);
  const short = Number(obj.short);
  const out: Mrs2PendingWithOrders = {
    long: Number.isFinite(long) && long > 0 ? long : null,
    short: Number.isFinite(short) && short > 0 ? short : null,
    longOrderId: obj.longOrderId != null && String(obj.longOrderId).trim()
      ? String(obj.longOrderId).trim()
      : null,
    shortOrderId: obj.shortOrderId != null && String(obj.shortOrderId).trim()
      ? String(obj.shortOrderId).trim()
      : null,
  };
  if (out.long == null && out.short == null && !out.longOrderId && !out.shortOrderId) {
    return null;
  }
  return out;
};

export const serializeMrs2PendingWithOrders = (p: Mrs2PendingWithOrders | null): string => {
  if (!p) return serializeMrs2PendingLimits(null);
  return JSON.stringify({
    long: p.long ?? null,
    short: p.short ?? null,
    longOrderId: p.longOrderId ?? null,
    shortOrderId: p.shortOrderId ?? null,
  });
};

const safeCancel = async (apiKeyName: string, symbol: string, orderId: string | null | undefined) => {
  if (!orderId) return;
  try {
    await cancelOrderById(apiKeyName, symbol, orderId);
  } catch (e) {
    logger.warn(`[mrs2-limits] cancel ${symbol} ${orderId} failed: ${(e as Error).message}`);
  }
};

/** Cancel any tracked resting MRS2 entry limits (call on fill / exit / disable). */
export const cancelMrs2RestingLimits = async (
  apiKeyName: string,
  symbol: string,
  pendingRaw: unknown,
): Promise<void> => {
  const pending = parseMrs2PendingWithOrders(pendingRaw);
  if (!pending) return;
  await safeCancel(apiKeyName, symbol, pending.longOrderId);
  await safeCancel(apiKeyName, symbol, pending.shortOrderId);
};

/**
 * Ensure resting limit buy/sell match sticky pending levels for mono MRS2.
 * Returns updated pending JSON (with order ids) to persist.
 */
export const syncMrs2RestingEntryLimits = async (args: {
  apiKeyName: string;
  symbol: string;
  pendingLevels: Mrs2PendingLimits | null;
  pendingRaw: unknown;
  qty: string;
}): Promise<string> => {
  const { apiKeyName, symbol, pendingLevels, qty } = args;
  const prev = parseMrs2PendingWithOrders(args.pendingRaw) || {
    long: null,
    short: null,
    longOrderId: null,
    shortOrderId: null,
  };

  const next: Mrs2PendingWithOrders = {
    long: pendingLevels?.long ?? null,
    short: pendingLevels?.short ?? null,
    longOrderId: prev.longOrderId ?? null,
    shortOrderId: prev.shortOrderId ?? null,
  };

  if (!(Number(qty) > 0)) {
    return serializeMrs2PendingWithOrders(next);
  }

  // Drop stale tracked ids if price level cleared or moved.
  if (next.long == null || priceChanged(prev.long, next.long)) {
    await safeCancel(apiKeyName, symbol, prev.longOrderId);
    next.longOrderId = null;
  }
  if (next.short == null || priceChanged(prev.short, next.short)) {
    await safeCancel(apiKeyName, symbol, prev.shortOrderId);
    next.shortOrderId = null;
  }

  // Optionally verify tracked orders still open.
  try {
    const open = await getOpenOrders(apiKeyName, symbol);
    const ids = new Set(
      (Array.isArray(open) ? open : []).map((o: any) => String(o?.id || o?.orderId || '')).filter(Boolean),
    );
    if (next.longOrderId && !ids.has(next.longOrderId)) next.longOrderId = null;
    if (next.shortOrderId && !ids.has(next.shortOrderId)) next.shortOrderId = null;
  } catch (e) {
    logger.warn(`[mrs2-limits] getOpenOrders ${symbol}: ${(e as Error).message}`);
  }

  if (next.long != null && !next.longOrderId) {
    try {
      const order = await placeOrder(
        apiKeyName,
        symbol,
        'Buy',
        qty,
        String(next.long),
      );
      next.longOrderId = asOrderId(order);
      logger.info(`[mrs2-limits] resting BUY ${symbol} @ ${next.long} qty=${qty} id=${next.longOrderId}`);
    } catch (e) {
      logger.warn(`[mrs2-limits] place BUY ${symbol} @ ${next.long}: ${(e as Error).message}`);
    }
  }

  if (next.short != null && !next.shortOrderId) {
    try {
      const order = await placeOrder(
        apiKeyName,
        symbol,
        'Sell',
        qty,
        String(next.short),
      );
      next.shortOrderId = asOrderId(order);
      logger.info(`[mrs2-limits] resting SELL ${symbol} @ ${next.short} qty=${qty} id=${next.shortOrderId}`);
    } catch (e) {
      logger.warn(`[mrs2-limits] place SELL ${symbol} @ ${next.short}: ${(e as Error).message}`);
    }
  }

  return serializeMrs2PendingWithOrders(next);
};

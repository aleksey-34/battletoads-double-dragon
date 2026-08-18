/**
 * MRS2 exchange-order helpers.
 * Live BT-parity: sticky bands live in mrs2_pending_json; do not rest intra-bar
 * limits on the book (`clearMrs2ExchangeRestingLimits`). `syncMrs2RestingEntryLimits`
 * is the old hamster place/replace path — not used by executeStrategy.
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

export type OpenOrderLite = {
  id: string;
  side: 'Buy' | 'Sell';
  price: number;
  orderType: string;
};

const asOpenOrderLite = (order: any): OpenOrderLite | null => {
  const id = asOrderId(order);
  const price = Number(order?.price ?? order?.info?.price ?? 0);
  if (!id || !Number.isFinite(price) || price <= 0) return null;
  const sideRaw = String(order?.side || order?.info?.side || '').toLowerCase();
  const side: 'Buy' | 'Sell' = sideRaw === 'buy' ? 'Buy' : 'Sell';
  const orderType = String(order?.orderType || order?.type || order?.info?.orderType || '').toLowerCase();
  return { id, side, price, orderType };
};

export const normalizeOpenOrders = (open: unknown): OpenOrderLite[] => (
  (Array.isArray(open) ? open : [])
    .map(asOpenOrderLite)
    .filter((o): o is OpenOrderLite => o != null)
);

/**
 * Resting entry limits matching `side` at (approximately) `targetPrice`, excluding
 * market/reduce-type entries. Used to detect MRS2 sticky entry limits that are
 * genuinely resting on the exchange but are NOT (or no longer) tracked in
 * mrs2_pending_json — e.g. after a crash between placeOrder() succeeding and the
 * order id being persisted, or a duplicate placed by an overlapping process.
 */
export const findMatchingRestingOrders = (
  orders: OpenOrderLite[],
  side: 'Buy' | 'Sell',
  targetPrice: number,
): OpenOrderLite[] => {
  if (!Number.isFinite(targetPrice) || targetPrice <= 0) return [];
  return orders.filter((o) => (
    o.side === side
    && o.orderType !== 'market'
    && !priceChanged(o.price, targetPrice)
  ));
};

/**
 * Given all resting orders matching a side/price, decide which single order id to
 * keep (preferring the already-tracked one, else the oldest/lowest-id match) and
 * which extra duplicate ids must be cancelled. Pure/testable — no exchange calls.
 */
export const reconcileRestingDuplicates = (
  matches: OpenOrderLite[],
  trackedId: string | null,
): { keepId: string | null; cancelIds: string[] } => {
  if (matches.length === 0) {
    return { keepId: null, cancelIds: [] };
  }
  const trackedMatch = trackedId ? matches.find((m) => m.id === trackedId) : undefined;
  const keep = trackedMatch || matches[0];
  const cancelIds = matches.filter((m) => m.id !== keep.id).map((m) => m.id);
  return { keepId: keep.id, cancelIds };
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
 * BT parity for live MRS: never rest exchange limits intra-bar.
 * Sticky bands stay in `mrs2_pending_json`; fills happen only when
 * `evaluateMrs2Bar` sees a closed-bar wick touch (then market-after-touch).
 * Cancels tracked ids and any leftover matching limits at those prices.
 */
export const clearMrs2ExchangeRestingLimits = async (args: {
  apiKeyName: string;
  symbol: string;
  pendingLevels: Mrs2PendingLimits | null;
  pendingRaw: unknown;
}): Promise<string> => {
  const { apiKeyName, symbol, pendingLevels } = args;
  const prev = parseMrs2PendingWithOrders(args.pendingRaw);
  await safeCancel(apiKeyName, symbol, prev?.longOrderId);
  await safeCancel(apiKeyName, symbol, prev?.shortOrderId);

  const next: Mrs2PendingWithOrders = {
    long: pendingLevels?.long ?? null,
    short: pendingLevels?.short ?? null,
    longOrderId: null,
    shortOrderId: null,
  };

  try {
    const openOrders = normalizeOpenOrders(await getOpenOrders(apiKeyName, symbol));
    const longPrices = [prev?.long, next.long].filter((px): px is number => Number(px) > 0);
    const shortPrices = [prev?.short, next.short].filter((px): px is number => Number(px) > 0);
    const seen = new Set<string>();
    for (const px of longPrices) {
      for (const o of findMatchingRestingOrders(openOrders, 'Buy', px)) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        logger.info(`[mrs2-limits] BT-parity cancel resting BUY ${symbol} id=${o.id} @ ${o.price}`);
        await safeCancel(apiKeyName, symbol, o.id);
      }
    }
    for (const px of shortPrices) {
      for (const o of findMatchingRestingOrders(openOrders, 'Sell', px)) {
        if (seen.has(o.id)) continue;
        seen.add(o.id);
        logger.info(`[mrs2-limits] BT-parity cancel resting SELL ${symbol} id=${o.id} @ ${o.price}`);
        await safeCancel(apiKeyName, symbol, o.id);
      }
    }
  } catch (e) {
    logger.warn(`[mrs2-limits] BT-parity getOpenOrders ${symbol}: ${(e as Error).message}`);
  }

  if (next.long == null && next.short == null) {
    return serializeMrs2PendingLimits(null);
  }
  return serializeMrs2PendingWithOrders(next);
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

  // ── Exchange-side reconciliation (dedup / adopt) ──────────────────────────
  // A single `mrs2_pending_json` order id is NOT sufficient to guarantee only one
  // resting order exists on the exchange: a process crash/restart between
  // placeOrder() succeeding and the id being persisted below, or two overlapping
  // executeStrategy() invocations (e.g. manual admin run racing the auto-cycle),
  // can leave an untracked duplicate resting limit on the book. Before trusting
  // "no tracked id => safe to place a new one", scan live open orders for ANY
  // resting entry at this side/price: adopt the first as tracked (skip placing a
  // redundant order) and cancel every extra duplicate found.
  let openOrders: OpenOrderLite[] = [];
  let fetchFailed = false;
  try {
    openOrders = normalizeOpenOrders(await getOpenOrders(apiKeyName, symbol));
  } catch (e) {
    fetchFailed = true;
    logger.warn(`[mrs2-limits] getOpenOrders ${symbol}: ${(e as Error).message}`);
  }

  if (!fetchFailed) {
    if (next.longOrderId && !openOrders.some((o) => o.id === next.longOrderId)) {
      next.longOrderId = null;
    }
    if (next.shortOrderId && !openOrders.some((o) => o.id === next.shortOrderId)) {
      next.shortOrderId = null;
    }

    if (next.long != null) {
      const longMatches = findMatchingRestingOrders(openOrders, 'Buy', next.long);
      const { keepId, cancelIds } = reconcileRestingDuplicates(longMatches, next.longOrderId ?? null);
      for (const dupId of cancelIds) {
        logger.warn(`[mrs2-limits] cancelling duplicate resting BUY ${symbol} order id=${dupId} @ ${next.long}`);
        await safeCancel(apiKeyName, symbol, dupId);
      }
      if (keepId && keepId !== next.longOrderId) {
        logger.warn(`[mrs2-limits] adopting untracked resting BUY ${symbol} order id=${keepId} @ ${next.long} (avoids duplicate placement)`);
      }
      next.longOrderId = keepId;
    }
    if (next.short != null) {
      const shortMatches = findMatchingRestingOrders(openOrders, 'Sell', next.short);
      const { keepId, cancelIds } = reconcileRestingDuplicates(shortMatches, next.shortOrderId ?? null);
      for (const dupId of cancelIds) {
        logger.warn(`[mrs2-limits] cancelling duplicate resting SELL ${symbol} order id=${dupId} @ ${next.short}`);
        await safeCancel(apiKeyName, symbol, dupId);
      }
      if (keepId && keepId !== next.shortOrderId) {
        logger.warn(`[mrs2-limits] adopting untracked resting SELL ${symbol} order id=${keepId} @ ${next.short} (avoids duplicate placement)`);
      }
      next.shortOrderId = keepId;
    }
  }
  // If the getOpenOrders fetch itself failed, skip dedup/adoption AND skip
  // placing new limits when we have no tracked id. Placing blind on an API
  // hiccup is how duplicate resting buys accumulate into oversize exposure.
  // With a tracked id we leave it alone until the next successful book scan.
  if (fetchFailed) {
    if ((next.long != null && !next.longOrderId) || (next.short != null && !next.shortOrderId)) {
      logger.warn(
        `[mrs2-limits] getOpenOrders failed for ${symbol} — refusing to place new resting limits `
        + `without book visibility (fail-closed; tracked long=${next.longOrderId || '-'} short=${next.shortOrderId || '-'})`,
      );
    }
    return serializeMrs2PendingWithOrders(next);
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

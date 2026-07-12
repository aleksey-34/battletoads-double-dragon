/**
 * DCA (Dollar Cost Averaging) — стратегия усреднения позиции при просадке.
 *
 * strategy_type = 'dca'
 * market_type   = 'spot' | 'futures'
 *
 * Логика:
 *  1. Открываем первую позицию (базовый ордер) при старте
 *  2. При падении цены на dca_step_percent — safety-ордер
 *  3. TP от средней цены закрывает всё
 *  4. SL: aggregate (от средней) или per-leg (dca_per_leg_sl=1) — закрывает одну ногу и освобождает слот
 */

import logger from '../utils/logger';
import { db } from '../utils/database';
import { getMarketData, placeOrder, getBalances } from './exchange';

export type DcaLeg = {
  price: number;
  qty: number;
  invested: number;
  isBase: boolean;
};

export type DcaConfig = {
  strategyId: number;
  apiKeyName: string;
  baseSymbol: string;
  quoteSymbol: string;
  marketType: 'spot' | 'futures';
  baseAmountUsdt: number;
  /** When > 0, first leg size = equity × percent / 100 (same as backtest). */
  baseAmountPercent: number;
  stepPercent: number;
  maxOrders: number;
  orderMultiplier: number;
  tpPercent: number;
  slPercent: number;
  perLegSl: boolean;
  orderType: 'market' | 'maker';
};

const resolveDcaOrderSizeUsdt = (
  config: Pick<DcaConfig, 'baseAmountUsdt' | 'baseAmountPercent' | 'orderMultiplier'>,
  equityUsdt: number,
  safetyOrderIndex: number,
): number => {
  const equityBase = Number.isFinite(equityUsdt) && equityUsdt > 0 ? equityUsdt : config.baseAmountUsdt;
  const base = config.baseAmountPercent > 0
    ? Math.max(1, (equityBase * config.baseAmountPercent) / 100)
    : Math.max(1, config.baseAmountUsdt);
  return Math.max(1, base * Math.pow(Math.max(1, config.orderMultiplier), Math.max(0, safetyOrderIndex)));
};

const MAKER_OFFSET = 0.001;

const parseDcaLegs = (raw: unknown): DcaLeg[] => {
  if (!raw) return [];
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => ({
        price: Number(item?.price || 0),
        qty: Number(item?.qty || 0),
        invested: Number(item?.invested || 0),
        isBase: Boolean(item?.isBase),
      }))
      .filter((leg) => leg.price > 0 && leg.qty > 0 && leg.invested > 0);
  } catch {
    return [];
  }
};

const serializeLegs = (legs: DcaLeg[]): string => JSON.stringify(legs);

const syncTotalsFromLegs = (legs: DcaLeg[]) => {
  const totalInvested = legs.reduce((sum, leg) => sum + leg.invested, 0);
  const totalQty = legs.reduce((sum, leg) => sum + leg.qty, 0);
  const ordersCount = legs.filter((leg) => !leg.isBase).length;
  const lastBuyPrice = legs.length > 0 ? legs[legs.length - 1].price : 0;
  return { totalInvested, totalQty, ordersCount, lastBuyPrice };
};

export const extractDcaConfig = (row: any): DcaConfig => ({
  strategyId: Number(row.id),
  apiKeyName: String(row.api_key_name || ''),
  baseSymbol: String(row.base_symbol || '').trim().toUpperCase(),
  quoteSymbol: String(row.quote_symbol || 'USDT').trim().toUpperCase(),
  marketType: String(row.market_type || 'spot') === 'futures' ? 'futures' : 'spot',
  baseAmountUsdt: Math.max(1, Number(row.dca_base_amount_usdt || 10)),
  baseAmountPercent: Math.max(0, Number(row.dca_base_amount_percent || 0)),
  stepPercent: Math.max(0.1, Number(row.dca_step_percent || 2)),
  maxOrders: Math.max(0, Math.floor(Number(row.dca_max_orders || 5))),
  orderMultiplier: Math.max(1, Number(row.dca_order_multiplier || 1)),
  tpPercent: Math.max(0.1, Number(row.dca_tp_percent || 3)),
  slPercent: Math.max(0, Number(row.dca_sl_percent || 0)),
  perLegSl: Number(row.dca_per_leg_sl || 0) === 1,
  orderType: String(row.dca_order_type || 'market') === 'maker' ? 'maker' : 'market',
});

/** Avoid ETHUSDT+USDT → ETHUSDTUSDT when base_symbol already includes quote. */
export const resolveDcaMarketSymbol = (baseSymbol: string, quoteSymbol: string): string => {
  const base = String(baseSymbol || '').trim().toUpperCase();
  const quote = String(quoteSymbol || 'USDT').trim().toUpperCase() || 'USDT';
  if (!base) return quote;
  if (base.endsWith(quote)) return base;
  return `${base}${quote}`;
};

const getCurrentPrice = async (apiKeyName: string, symbol: string): Promise<number> => {
  const candles = await getMarketData(apiKeyName, symbol, '1m', 1, {});
  const last = Array.isArray(candles) ? candles[candles.length - 1] : null;
  return last ? Number((last as any)[4] || (last as any).close || 0) : 0;
};

const buyOrder = async (
  config: DcaConfig,
  sizeUsdt: number,
  currentPrice: number,
): Promise<number> => {
  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  const qty = sizeUsdt / currentPrice;
  const exchangeMarketType: 'spot' | 'swap' = config.marketType === 'spot' ? 'spot' : 'swap';

  if (config.orderType === 'maker') {
    const limitPrice = currentPrice * (1 - MAKER_OFFSET);
    logger.info(`[dca] strategy ${config.strategyId}: maker buy ${qty.toFixed(6)} ${config.baseSymbol} @ ${limitPrice.toFixed(4)}`);
    try {
      await placeOrder(config.apiKeyName, symbol, 'Buy', String(qty), String(limitPrice), { marketType: exchangeMarketType });
      await new Promise((r) => setTimeout(r, 30_000));
    } catch (err) {
      logger.warn(`[dca] strategy ${config.strategyId}: maker failed, fallback market: ${(err as Error).message}`);
    }
  }

  logger.info(`[dca] strategy ${config.strategyId}: market buy ${qty.toFixed(6)} ${config.baseSymbol} @ ~${currentPrice.toFixed(4)}`);
  await placeOrder(config.apiKeyName, symbol, 'Buy', String(qty), undefined, { marketType: exchangeMarketType });
  return qty;
};

const sellQty = async (config: DcaConfig, qty: number, reason: string): Promise<void> => {
  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  const exchangeMarketType: 'spot' | 'swap' = config.marketType === 'spot' ? 'spot' : 'swap';
  logger.info(`[dca] strategy ${config.strategyId}: sell ${qty.toFixed(6)} (${reason})`);
  await placeOrder(config.apiKeyName, symbol, 'Sell', String(qty), undefined, { marketType: exchangeMarketType });
};

const persistOpenState = async (
  strategyId: number,
  legs: DcaLeg[],
): Promise<void> => {
  const { totalInvested, totalQty, ordersCount, lastBuyPrice } = syncTotalsFromLegs(legs);
  await db.run(
    `UPDATE strategies SET
      dca_state = ?,
      dca_orders_count = ?,
      dca_total_invested_usdt = ?,
      dca_total_qty = ?,
      dca_last_buy_price = ?,
      dca_legs_json = ?
    WHERE id = ?`,
    [
      legs.length > 0 ? 'open' : 'idle',
      ordersCount,
      totalInvested,
      totalQty,
      lastBuyPrice,
      serializeLegs(legs),
      strategyId,
    ],
  );
};

const resetIdle = async (strategyId: number): Promise<void> => {
  await db.run(
    `UPDATE strategies SET dca_state='idle', dca_orders_count=0, dca_total_invested_usdt=0,
     dca_total_qty=0, dca_last_buy_price=0, dca_legs_json='[]' WHERE id=?`,
    [strategyId],
  );
};

export const executeDca = async (
  apiKeyName: string,
  strategyId: number,
): Promise<{ action: string; details?: string }> => {
  const row = await db.get(
    `SELECT s.*, a.name AS api_key_name
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE s.id = ? AND a.name = ?`,
    [strategyId, apiKeyName]
  );

  if (!row) throw new Error(`DCA strategy ${strategyId} not found for key ${apiKeyName}`);

  const config = extractDcaConfig(row);
  if (!config.baseSymbol || !config.quoteSymbol) throw new Error('dca: base_symbol and quote_symbol required');

  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  const state: string = String(row.dca_state || 'idle');
  let legs = parseDcaLegs(row.dca_legs_json);
  const legacyTotalQty = Number(row.dca_total_qty || 0);
  const legacyTotalInvested = Number(row.dca_total_invested_usdt || 0);
  const legacyLastBuy = Number(row.dca_last_buy_price || 0);
  if (legs.length === 0 && legacyTotalQty > 0 && legacyTotalInvested > 0) {
    legs = [{
      price: legacyLastBuy > 0 ? legacyLastBuy : legacyTotalInvested / legacyTotalQty,
      qty: legacyTotalQty,
      invested: legacyTotalInvested,
      isBase: true,
    }];
  }
  const totals = syncTotalsFromLegs(legs);
  const avgBuyPrice = totals.totalQty > 0 ? totals.totalInvested / totals.totalQty : 0;

  let currentPrice = 0;
  try {
    currentPrice = await getCurrentPrice(apiKeyName, symbol);
  } catch (err) {
    throw new Error(`dca: failed to get price for ${symbol}: ${(err as Error).message}`);
  }

  if (currentPrice <= 0) return { action: 'skip', details: 'price=0' };

  let equityUsdt = config.baseAmountUsdt;
  try {
    const balances = await getBalances(apiKeyName);
    const usdtEntry = (Array.isArray(balances) ? balances : []).find(
      (b: any) =>
        String(b.coin || '').toUpperCase() === 'USDT' &&
        (config.marketType === 'spot'
          ? String(b.accountType || '').toLowerCase() === 'spot'
          : String(b.accountType || '').toLowerCase() !== 'spot'),
    );
    const wallet = Number(String((usdtEntry as { walletBalance?: string | number })?.walletBalance || 0));
    const available = Number(String((usdtEntry as { availableBalance?: string | number })?.availableBalance || 0));
    equityUsdt = wallet > 0 ? wallet : (available > 0 ? available : equityUsdt);
  } catch {
    // keep fallback baseAmountUsdt
  }

  if (state === 'open' && legs.length > 0 && avgBuyPrice > 0) {
    const tpPrice = avgBuyPrice * (1 + config.tpPercent / 100);

    if (currentPrice >= tpPrice) {
      await sellQty(config, totals.totalQty, `TP hit price=${currentPrice.toFixed(4)} >= tp=${tpPrice.toFixed(4)}`);
      await resetIdle(strategyId);
      return { action: 'tp_close', details: `price=${currentPrice.toFixed(4)}, tp=${tpPrice.toFixed(4)}` };
    }

    if (config.perLegSl && config.slPercent > 0) {
      let closedAny = false;
      for (let i = 0; i < legs.length; ) {
        const leg = legs[i];
        const legSl = leg.price * (1 - config.slPercent / 100);
        if (currentPrice <= legSl) {
          await sellQty(config, leg.qty, `leg SL price=${currentPrice.toFixed(4)} <= ${legSl.toFixed(4)}`);
          legs.splice(i, 1);
          closedAny = true;
        } else {
          i += 1;
        }
      }
      if (closedAny) {
        if (legs.length === 0) {
          await resetIdle(strategyId);
          return { action: 'leg_sl_flat', details: `all legs closed at ${currentPrice.toFixed(4)}` };
        }
        await persistOpenState(strategyId, legs);
        const nextTotals = syncTotalsFromLegs(legs);
        return {
          action: 'leg_sl_partial',
          details: `legs=${legs.length}, orders=${nextTotals.ordersCount}, avg=${(nextTotals.totalInvested / nextTotals.totalQty).toFixed(4)}`,
        };
      }
    } else if (config.slPercent > 0) {
      const slPrice = avgBuyPrice * (1 - config.slPercent / 100);
      if (currentPrice <= slPrice) {
        await sellQty(config, totals.totalQty, `aggregate SL price=${currentPrice.toFixed(4)} <= sl=${slPrice.toFixed(4)}`);
        await resetIdle(strategyId);
        return { action: 'sl_close', details: `price=${currentPrice.toFixed(4)}, sl=${slPrice.toFixed(4)}` };
      }
    }

    const { ordersCount, lastBuyPrice } = syncTotalsFromLegs(legs);
    if (lastBuyPrice > 0 && ordersCount < config.maxOrders) {
      const stepTrigger = lastBuyPrice * (1 - config.stepPercent / 100);
      if (currentPrice <= stepTrigger) {
        const safetySize = resolveDcaOrderSizeUsdt(config, equityUsdt, ordersCount);
        logger.info(`[dca] strategy ${strategyId}: safety order #${ordersCount + 1}, size=${safetySize.toFixed(2)} USDT`);
        const bought = await buyOrder(config, safetySize, currentPrice);
        legs.push({ price: currentPrice, qty: bought, invested: safetySize, isBase: false });
        await persistOpenState(strategyId, legs);
        const nextTotals = syncTotalsFromLegs(legs);
        const newAvg = nextTotals.totalInvested / nextTotals.totalQty;
        return {
          action: 'safety_buy',
          details: `order #${nextTotals.ordersCount}, price=${currentPrice.toFixed(4)}, avg=${newAvg.toFixed(4)}`,
        };
      }
    }

    return { action: 'hold', details: `price=${currentPrice.toFixed(4)}, avg=${avgBuyPrice.toFixed(4)}, tp=${tpPrice.toFixed(4)}, legs=${legs.length}` };
  }

  if (state === 'idle') {
    const baseSize = resolveDcaOrderSizeUsdt(config, equityUsdt, 0);
    try {
      const balances = await getBalances(apiKeyName);
      const usdtEntry = (Array.isArray(balances) ? balances : []).find(
        (b: any) =>
          String(b.coin || '').toUpperCase() === 'USDT' &&
          (config.marketType === 'spot'
            ? String(b.accountType || '').toLowerCase() === 'spot'
            : String(b.accountType || '').toLowerCase() !== 'spot'),
      );
      const available = Number(usdtEntry?.availableBalance || 0);
      if (available < baseSize) {
        return { action: 'skip', details: `insufficient balance ${available.toFixed(2)} < ${baseSize.toFixed(2)}` };
      }
    } catch {
      // proceed without balance check
    }

    logger.info(`[dca] strategy ${strategyId}: opening base position, ${baseSize.toFixed(2)} USDT${config.baseAmountPercent > 0 ? ` (${config.baseAmountPercent}% of ~${equityUsdt.toFixed(0)} equity)` : ''}`);
    const bought = await buyOrder(config, baseSize, currentPrice);
    legs = [{ price: currentPrice, qty: bought, invested: baseSize, isBase: true }];
    await persistOpenState(strategyId, legs);
    return { action: 'base_buy', details: `${bought.toFixed(6)} ${config.baseSymbol} @ ${currentPrice.toFixed(4)}` };
  }

  return { action: 'noop', details: `state=${state}` };
};

/**
 * DCA (Dollar Cost Averaging) — стратегия усреднения позиции при просадке.
 *
 * strategy_type = 'dca'
 * market_type   = 'spot' | 'futures'
 *
 * Логика:
 *  1. Открываем первую позицию (базовый ордер) при старте
 *  2. При падении цены на dca_step_percent от цены последней покупки — добавляем
 *     safety-ордер (усредняем)
 *  3. dca_max_orders — максимальное кол-во safety ордеров
 *  4. При достижении TP (средняя цена * (1 + dca_tp_percent/100)) — закрываем всё
 *  5. При достижении SL (средняя цена * (1 - dca_sl_percent/100)) — закрываем всё
 *  6. dca_order_multiplier — каждый следующий safety-ордер в X раз больше предыдущего
 *
 * Поля в DB (стратегия):
 *  dca_base_amount_usdt    — первый ордер, в USDT
 *  dca_step_percent        — % падения для следующего safety order
 *  dca_max_orders          — макс кол-во safety orders (не считая базовый)
 *  dca_order_multiplier    — множитель размера каждого следующего ордера (1.0 = равный)
 *  dca_tp_percent          — TakeProfit от средней цены (%)
 *  dca_sl_percent          — StopLoss от средней цены (0 = выключен)
 *  dca_order_type          — 'market' | 'maker'
 *  dca_orders_count        — текущее кол-во исполненных safety orders
 *  dca_total_invested_usdt — суммарно вложено
 *  dca_total_qty           — суммарно куплено (базовый актив)
 *  dca_last_buy_price      — цена последней покупки
 *  dca_state               — 'idle' | 'open' | 'closed'
 */

import logger from '../utils/logger';
import { db } from '../utils/database';
import { getMarketData, placeOrder, getBalances } from './exchange';

export type DcaConfig = {
  strategyId: number;
  apiKeyName: string;
  baseSymbol: string;
  quoteSymbol: string;
  marketType: 'spot' | 'futures';
  baseAmountUsdt: number;
  stepPercent: number;
  maxOrders: number;
  orderMultiplier: number;
  tpPercent: number;
  slPercent: number;
  orderType: 'market' | 'maker';
};

const MAKER_OFFSET = 0.001;

export const extractDcaConfig = (row: any): DcaConfig => ({
  strategyId: Number(row.id),
  apiKeyName: String(row.api_key_name || ''),
  baseSymbol: String(row.base_symbol || '').trim().toUpperCase(),
  quoteSymbol: String(row.quote_symbol || 'USDT').trim().toUpperCase(),
  marketType: String(row.market_type || 'spot') === 'futures' ? 'futures' : 'spot',
  baseAmountUsdt: Math.max(1, Number(row.dca_base_amount_usdt || 10)),
  stepPercent: Math.max(0.1, Number(row.dca_step_percent || 2)),
  maxOrders: Math.max(0, Math.floor(Number(row.dca_max_orders || 5))),
  orderMultiplier: Math.max(1, Number(row.dca_order_multiplier || 1)),
  tpPercent: Math.max(0.1, Number(row.dca_tp_percent || 3)),
  slPercent: Math.max(0, Number(row.dca_sl_percent || 0)),
  orderType: String(row.dca_order_type || 'market') === 'maker' ? 'maker' : 'market',
});

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
  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
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

const sellAll = async (config: DcaConfig, totalQty: number, reason: string): Promise<void> => {
  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
  const exchangeMarketType: 'spot' | 'swap' = config.marketType === 'spot' ? 'spot' : 'swap';
  logger.info(`[dca] strategy ${config.strategyId}: closing position (${reason}), qty=${totalQty.toFixed(6)}`);
  await placeOrder(config.apiKeyName, symbol, 'Sell', String(totalQty), undefined, { marketType: exchangeMarketType });
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

  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
  const state: string = String(row.dca_state || 'idle');
  const ordersCount = Number(row.dca_orders_count || 0);
  const totalInvested = Number(row.dca_total_invested_usdt || 0);
  const totalQty = Number(row.dca_total_qty || 0);
  const lastBuyPrice = Number(row.dca_last_buy_price || 0);
  const avgBuyPrice = totalQty > 0 && totalInvested > 0 ? totalInvested / totalQty : 0;

  let currentPrice = 0;
  try {
    currentPrice = await getCurrentPrice(apiKeyName, symbol);
  } catch (err) {
    throw new Error(`dca: failed to get price for ${symbol}: ${(err as Error).message}`);
  }

  if (currentPrice <= 0) return { action: 'skip', details: 'price=0' };

  // ── Если позиция открыта — проверяем TP/SL/safety orders ──
  if (state === 'open' && totalQty > 0 && avgBuyPrice > 0) {
    const tpPrice = avgBuyPrice * (1 + config.tpPercent / 100);
    const slPrice = config.slPercent > 0 ? avgBuyPrice * (1 - config.slPercent / 100) : 0;

    // TP
    if (currentPrice >= tpPrice) {
      await sellAll(config, totalQty, `TP hit price=${currentPrice.toFixed(4)} >= tp=${tpPrice.toFixed(4)}`);
      await db.run(
        `UPDATE strategies SET dca_state='idle', dca_orders_count=0, dca_total_invested_usdt=0,
         dca_total_qty=0, dca_last_buy_price=0 WHERE id=?`,
        [strategyId]
      );
      return { action: 'tp_close', details: `price=${currentPrice.toFixed(4)}, tp=${tpPrice.toFixed(4)}` };
    }

    // SL
    if (slPrice > 0 && currentPrice <= slPrice) {
      await sellAll(config, totalQty, `SL hit price=${currentPrice.toFixed(4)} <= sl=${slPrice.toFixed(4)}`);
      await db.run(
        `UPDATE strategies SET dca_state='idle', dca_orders_count=0, dca_total_invested_usdt=0,
         dca_total_qty=0, dca_last_buy_price=0 WHERE id=?`,
        [strategyId]
      );
      return { action: 'sl_close', details: `price=${currentPrice.toFixed(4)}, sl=${slPrice.toFixed(4)}` };
    }

    // Safety order: цена упала на stepPercent от цены последней покупки
    if (lastBuyPrice > 0 && ordersCount < config.maxOrders) {
      const stepTrigger = lastBuyPrice * (1 - config.stepPercent / 100);
      if (currentPrice <= stepTrigger) {
        // Размер safety order = base * multiplier^ordersCount
        const safetySize = config.baseAmountUsdt * Math.pow(config.orderMultiplier, ordersCount);
        logger.info(`[dca] strategy ${strategyId}: safety order #${ordersCount + 1}, size=${safetySize.toFixed(2)} USDT`);

        const bought = await buyOrder(config, safetySize, currentPrice);
        await db.run(
          `UPDATE strategies SET
            dca_orders_count = ?,
            dca_total_invested_usdt = ?,
            dca_total_qty = ?,
            dca_last_buy_price = ?
          WHERE id = ?`,
          [ordersCount + 1, totalInvested + safetySize, totalQty + bought, currentPrice, strategyId]
        );
        const newAvg = (totalInvested + safetySize) / (totalQty + bought);
        return {
          action: 'safety_buy',
          details: `order #${ordersCount + 1}, price=${currentPrice.toFixed(4)}, avg=${newAvg.toFixed(4)}`,
        };
      }
    }

    return { action: 'hold', details: `price=${currentPrice.toFixed(4)}, avg=${avgBuyPrice.toFixed(4)}, tp=${tpPrice.toFixed(4)}` };
  }

  // ── Idle: открываем первую позицию ──
  if (state === 'idle') {
    let availableUsdt = config.baseAmountUsdt;

    // Если percent-based — можно добавить дополнительную проверку баланса
    try {
      const balances = await getBalances(apiKeyName);
      const usdtEntry = (Array.isArray(balances) ? balances : []).find(
        (b: any) =>
          String(b.coin || '').toUpperCase() === 'USDT' &&
          (config.marketType === 'spot'
            ? String(b.accountType || '').toLowerCase() === 'spot'
            : String(b.accountType || '').toLowerCase() !== 'spot')
      );
      const available = Number(usdtEntry?.availableBalance || 0);
      if (available < config.baseAmountUsdt) {
        return { action: 'skip', details: `insufficient balance ${available.toFixed(2)} < ${config.baseAmountUsdt}` };
      }
      availableUsdt = config.baseAmountUsdt;
    } catch {
      // нет доступа к балансу — пробуем разместить ордер как есть
    }

    logger.info(`[dca] strategy ${strategyId}: opening base position, ${availableUsdt} USDT`);
    const bought = await buyOrder(config, availableUsdt, currentPrice);
    await db.run(
      `UPDATE strategies SET
        dca_state = 'open',
        dca_orders_count = 0,
        dca_total_invested_usdt = ?,
        dca_total_qty = ?,
        dca_last_buy_price = ?
      WHERE id = ?`,
      [availableUsdt, bought, currentPrice, strategyId]
    );
    return { action: 'base_buy', details: `${bought.toFixed(6)} ${config.baseSymbol} @ ${currentPrice.toFixed(4)}` };
  }

  return { action: 'noop', details: `state=${state}` };
};

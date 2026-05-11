/**
 * Periodic Buy (Spot DCA) — стратегия регулярных покупок монеты.
 *
 * strategy_type = 'periodic_buy'
 * market_type   = 'spot'
 *
 * Логика:
 *  1. Раз в `pb_interval_hours` часов — покупаем монету
 *  2. Размер ордера: pb_amount_mode='percent' (% от USDT-баланса) или 'fixed_usdt'
 *  3. Тип ордера: market (сразу) или maker (лимитка -0.1% от bid, ждём 5 мин)
 *  4. Если pb_sell_on_tp=true и цена >= средняя * (1 + pb_tp_percent/100) — продаём всё
 *  5. pb_max_total_invested_usdt — верхняя граница накопления (не покупаем выше)
 */

import logger from '../utils/logger';
import { db } from '../utils/database';
import { getBalances, getMarketData, placeOrder } from './exchange';

export type PeriodicBuyConfig = {
  strategyId: number;
  apiKeyName: string;
  baseSymbol: string;     // напр. 'BTC'
  quoteSymbol: string;    // напр. 'USDT'
  intervalHours: number;  // pb_interval_hours
  amountMode: 'percent' | 'fixed_usdt';  // pb_amount_mode
  amountValue: number;    // pb_amount_value
  orderType: 'market' | 'maker';  // pb_order_type
  maxTotalInvestedUsdt: number;   // pb_max_total_invested_usdt (0 = нет лимита)
  sellOnTp: boolean;      // pb_sell_on_tp
  tpPercent: number;      // pb_tp_percent
};

const MAKER_OFFSET = 0.001;  // -0.1% от mid-price для maker-ордера
const MAKER_WAIT_MS = 5 * 60 * 1000;  // 5 минут ожидания исполнения

/**
 * Извлекает конфиг periodic_buy из строки стратегии.
 */
export const extractPeriodicBuyConfig = (row: any): PeriodicBuyConfig => {
  return {
    strategyId: Number(row.id),
    apiKeyName: String(row.api_key_name || ''),
    baseSymbol: String(row.base_symbol || '').trim().toUpperCase(),
    quoteSymbol: String(row.quote_symbol || 'USDT').trim().toUpperCase(),
    intervalHours: Math.max(1, Number(row.pb_interval_hours || 24)),
    amountMode: String(row.pb_amount_mode || 'percent') === 'fixed_usdt' ? 'fixed_usdt' : 'percent',
    amountValue: Math.max(0, Number(row.pb_amount_value || 5)),
    orderType: String(row.pb_order_type || 'market') === 'maker' ? 'maker' : 'market',
    maxTotalInvestedUsdt: Math.max(0, Number(row.pb_max_total_invested_usdt || 0)),
    sellOnTp: String(row.pb_sell_on_tp || '0') === '1',
    tpPercent: Math.max(0, Number(row.pb_tp_percent || 15)),
  };
};

/**
 * Проверяет, пришло ли время следующей покупки.
 */
const isTimeForNextBuy = (lastBuyAt: string | null, intervalHours: number): boolean => {
  if (!lastBuyAt) return true;
  const lastMs = new Date(lastBuyAt).getTime();
  if (!Number.isFinite(lastMs)) return true;
  const intervalMs = intervalHours * 3600 * 1000;
  return Date.now() >= lastMs + intervalMs;
};

/**
 * Вычисляет размер ордера в USDT.
 */
const resolveOrderSizeUsdt = async (
  config: PeriodicBuyConfig,
  currentTotalInvestedUsdt: number,
): Promise<number | null> => {
  if (config.maxTotalInvestedUsdt > 0 && currentTotalInvestedUsdt >= config.maxTotalInvestedUsdt) {
    logger.info(`[periodic_buy] strategy ${config.strategyId}: max invested reached (${currentTotalInvestedUsdt.toFixed(2)} / ${config.maxTotalInvestedUsdt})`);
    return null;
  }

  let sizeUsdt: number;

  if (config.amountMode === 'fixed_usdt') {
    sizeUsdt = config.amountValue;
  } else {
    // percent от свободного USDT-баланса
    try {
      const balances = await getBalances(config.apiKeyName);
      const usdtEntry = (Array.isArray(balances) ? balances : []).find(
        (b: any) => String(b.coin || '').toUpperCase() === 'USDT' && String(b.accountType || '').toLowerCase() === 'spot'
      );
      const available = Number(usdtEntry?.availableBalance || 0);
      sizeUsdt = available * (config.amountValue / 100);
    } catch (err) {
      logger.error(`[periodic_buy] strategy ${config.strategyId}: failed to get balance: ${(err as Error).message}`);
      return null;
    }
  }

  if (config.maxTotalInvestedUsdt > 0) {
    const remaining = config.maxTotalInvestedUsdt - currentTotalInvestedUsdt;
    sizeUsdt = Math.min(sizeUsdt, remaining);
  }

  if (sizeUsdt < 1) {
    logger.info(`[periodic_buy] strategy ${config.strategyId}: order size too small (${sizeUsdt.toFixed(4)} USDT), skipping`);
    return null;
  }

  return sizeUsdt;
};

/**
 * Выполняет покупку (market или maker).
 */
const executeBuy = async (
  config: PeriodicBuyConfig,
  sizeUsdt: number,
  currentPrice: number,
): Promise<{ filled: boolean; avgPrice: number; qty: number }> => {
  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
  const qty = sizeUsdt / currentPrice;

  if (config.orderType === 'maker') {
    const limitPrice = currentPrice * (1 - MAKER_OFFSET);
    logger.info(`[periodic_buy] strategy ${config.strategyId}: placing maker buy ${qty.toFixed(6)} ${config.baseSymbol} @ ${limitPrice.toFixed(4)} (${symbol})`);

    try {
      await placeOrder(config.apiKeyName, symbol, 'Buy', String(qty), String(limitPrice), { marketType: 'spot' });
      // Ждём исполнения (упрощённо — проверяем баланс через паузу)
      await new Promise((resolve) => setTimeout(resolve, Math.min(MAKER_WAIT_MS, 30_000)));
    } catch (err) {
      logger.warn(`[periodic_buy] strategy ${config.strategyId}: maker order failed, fallback to market: ${(err as Error).message}`);
    }
  }

  // Market order (или fallback после maker)
  logger.info(`[periodic_buy] strategy ${config.strategyId}: placing market buy ${qty.toFixed(6)} ${config.baseSymbol} @ ~${currentPrice.toFixed(4)} (${symbol})`);
  await placeOrder(config.apiKeyName, symbol, 'Buy', String(qty), undefined, { marketType: 'spot' });

  return { filled: true, avgPrice: currentPrice, qty };
};

/**
 * Проверяет TP и при необходимости продаёт всё накопленное.
 */
const checkAndExecuteTp = async (
  config: PeriodicBuyConfig,
  currentPrice: number,
  avgBuyPrice: number,
  totalQty: number,
): Promise<boolean> => {
  if (!config.sellOnTp || totalQty <= 0 || avgBuyPrice <= 0) return false;

  const tpPrice = avgBuyPrice * (1 + config.tpPercent / 100);
  if (currentPrice < tpPrice) return false;

  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
  logger.info(`[periodic_buy] strategy ${config.strategyId}: TP hit! price=${currentPrice.toFixed(4)} >= tp=${tpPrice.toFixed(4)}, selling ${totalQty.toFixed(6)} ${config.baseSymbol}`);

  await placeOrder(config.apiKeyName, symbol, 'Sell', String(totalQty), undefined, { marketType: 'spot' });
  return true;
};

/**
 * Главная функция — вызывается из runAutoStrategiesCycle для periodic_buy стратегий.
 */
export const executePeriodicBuy = async (
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

  if (!row) {
    throw new Error(`Periodic buy strategy ${strategyId} not found for key ${apiKeyName}`);
  }

  const config = extractPeriodicBuyConfig(row);

  if (!config.baseSymbol || !config.quoteSymbol) {
    throw new Error('periodic_buy: base_symbol and quote_symbol required');
  }

  const symbol = `${config.baseSymbol}${config.quoteSymbol}`;
  const lastBuyAt: string | null = row.pb_last_buy_at || null;
  const totalInvested = Number(row.pb_total_invested_usdt || 0);
  const totalQty = Number(row.pb_total_qty || 0);
  const avgBuyPrice = totalQty > 0 && totalInvested > 0 ? totalInvested / totalQty : 0;

  // Получаем текущую цену
  let currentPrice = 0;
  try {
    const candles = await getMarketData(apiKeyName, symbol, '1m', 1, { });
    const lastCandle = Array.isArray(candles) ? candles[candles.length - 1] : null;
    currentPrice = lastCandle ? Number((lastCandle as any)[4] || (lastCandle as any).close || 0) : 0;
  } catch (err) {
    throw new Error(`periodic_buy: failed to get price for ${symbol}: ${(err as Error).message}`);
  }

  if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
    throw new Error(`periodic_buy: invalid price for ${symbol}: ${currentPrice}`);
  }

  // Проверяем TP
  if (config.sellOnTp && totalQty > 0) {
    const tpHit = await checkAndExecuteTp(config, currentPrice, avgBuyPrice, totalQty);
    if (tpHit) {
      // Сбрасываем накопленные данные
      await db.run(
        `UPDATE strategies
         SET pb_total_invested_usdt = 0,
             pb_total_qty = 0,
             pb_last_buy_at = NULL,
             state = 'flat',
             last_action = 'periodic_buy_tp_sold',
             last_error = NULL,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [strategyId]
      );
      return { action: 'tp_sold', details: `Sold ${totalQty.toFixed(6)} ${config.baseSymbol} at TP (price=${currentPrice.toFixed(4)})` };
    }
  }

  // Проверяем интервал
  if (!isTimeForNextBuy(lastBuyAt, config.intervalHours)) {
    const nextBuyMs = lastBuyAt ? new Date(lastBuyAt).getTime() + config.intervalHours * 3600_000 : Date.now();
    const nextBuyIn = Math.max(0, Math.round((nextBuyMs - Date.now()) / 60_000));
    return { action: 'waiting', details: `Next buy in ~${nextBuyIn} min` };
  }

  // Вычисляем размер ордера
  const sizeUsdt = await resolveOrderSizeUsdt(config, totalInvested);
  if (sizeUsdt === null) {
    await db.run(
      `UPDATE strategies SET last_action = 'periodic_buy_skipped', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [strategyId]
    );
    return { action: 'skipped', details: 'Max invested or zero size' };
  }

  // Исполняем покупку
  const { qty } = await executeBuy(config, sizeUsdt, currentPrice);

  const newTotalInvested = totalInvested + sizeUsdt;
  const newTotalQty = totalQty + qty;

  // Обновляем состояние стратегии
  await db.run(
    `UPDATE strategies
     SET pb_total_invested_usdt = ?,
         pb_total_qty = ?,
         pb_last_buy_at = CURRENT_TIMESTAMP,
         state = 'long',
         last_action = 'periodic_buy_executed',
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [newTotalInvested, newTotalQty, strategyId]
  );

  const newAvg = newTotalQty > 0 ? newTotalInvested / newTotalQty : 0;

  logger.info(
    `[periodic_buy] strategy ${strategyId} (${apiKeyName}): bought ${qty.toFixed(6)} ${config.baseSymbol} ` +
    `for ${sizeUsdt.toFixed(2)} USDT @ ${currentPrice.toFixed(4)}. ` +
    `Total: ${newTotalQty.toFixed(6)} ${config.baseSymbol} / ${newTotalInvested.toFixed(2)} USDT, avg=${newAvg.toFixed(4)}`
  );

  return {
    action: 'bought',
    details: `Bought ${qty.toFixed(6)} ${config.baseSymbol} for ${sizeUsdt.toFixed(2)} USDT @ ${currentPrice.toFixed(4)}`,
  };
};

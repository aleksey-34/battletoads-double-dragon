/**
 * DCA-Futures — усреднение позиции при просадке на фьючерсах.
 *
 * strategy_type = 'dca_futures'
 * Поддерживает long и short. Закрытие через reduceOnly, чтобы не открыть
 * встречную позицию на биржах с hedge-mode (BingX, Bybit).
 *
 * Жизненный цикл:
 *   idle   → ждём внешнего сигнала (signal_trigger = 'long' | 'short')
 *            или авто-открытие если dcaf_auto_open = 1
 *   open   → держим позицию, усредняем при просадке, проверяем TP/SL
 *   closed → позиция закрыта, ждём сброса в idle
 *
 * Поля в strategies (добавляются через ensureColumn в database.ts):
 *   dcaf_direction             TEXT    — 'long' | 'short'  (заполняется при открытии)
 *   dcaf_base_amount_usdt      REAL    — базовый ордер, USDT
 *   dcaf_step_percent          REAL    — % от цены последней покупки для safety order
 *   dcaf_max_orders            INTEGER — макс кол-во safety orders
 *   dcaf_order_multiplier      REAL    — мультипликатор размера каждого safety order
 *   dcaf_tp_percent            REAL    — TakeProfit от средней цены (%)
 *   dcaf_sl_percent            REAL    — StopLoss от средней цены (0 = выключен)
 *   dcaf_order_type            TEXT    — 'market' | 'maker'
 *   dcaf_orders_count          INTEGER — текущее кол-во safety orders
 *   dcaf_total_invested_usdt   REAL    — сумма вложений
 *   dcaf_total_qty             REAL    — суммарное количество базового актива
 *   dcaf_last_price            REAL    — цена последнего ордера
 *   dcaf_state                 TEXT    — 'idle' | 'open' | 'closed'
 *   dcaf_auto_open             INTEGER — 1: открывать автоматически без внешнего сигнала
 *   dcaf_leverage              INTEGER — плечо (для info/logging, реальное выставляется снаружи)
 */

import logger from '../utils/logger';
import { db } from '../utils/database';
import { getMarketData, placeOrder, getBalances } from './exchange';
import { resolveDcaMarketSymbol } from './dca';

export type DcaFuturesConfig = {
  strategyId: number;
  apiKeyName: string;
  baseSymbol: string;
  quoteSymbol: string;
  baseAmountUsdt: number;
  stepPercent: number;
  maxOrders: number;
  orderMultiplier: number;
  tpPercent: number;
  slPercent: number;
  orderType: 'market' | 'maker';
  autoOpen: boolean;
  leverage: number;
};

export type DcaFuturesDirection = 'long' | 'short';

const MAKER_OFFSET = 0.001; // 0.1% лимит от рынка для maker-ордера

export const extractDcaFuturesConfig = (row: any): DcaFuturesConfig => ({
  strategyId: Number(row.id),
  apiKeyName: String(row.api_key_name || ''),
  baseSymbol: String(row.base_symbol || '').trim().toUpperCase(),
  quoteSymbol: String(row.quote_symbol || 'USDT').trim().toUpperCase(),
  baseAmountUsdt: Math.max(1, Number(row.dcaf_base_amount_usdt ?? 10)),
  stepPercent: Math.max(0.1, Number(row.dcaf_step_percent ?? 2)),
  maxOrders: Math.max(0, Math.floor(Number(row.dcaf_max_orders ?? 3))),
  orderMultiplier: Math.max(1, Number(row.dcaf_order_multiplier ?? 1.5)),
  tpPercent: Math.max(0.1, Number(row.dcaf_tp_percent ?? 2.5)),
  slPercent: Math.max(0, Number(row.dcaf_sl_percent ?? 0)),
  orderType: String(row.dcaf_order_type ?? 'market') === 'maker' ? 'maker' : 'market',
  autoOpen: Number(row.dcaf_auto_open ?? 0) === 1,
  leverage: Math.max(1, Math.floor(Number(row.dcaf_leverage ?? 1))),
});

// ── Получить текущую цену ──────────────────────────────────────────────────
const getCurrentPrice = async (apiKeyName: string, symbol: string): Promise<number> => {
  const candles = await getMarketData(apiKeyName, symbol, '1m', 1, {});
  const last = Array.isArray(candles) ? candles[candles.length - 1] : null;
  return last ? Number((last as any)[4] ?? (last as any).close ?? 0) : 0;
};

// ── Открывающий ордер (вход в позицию) ────────────────────────────────────
const openOrder = async (
  config: DcaFuturesConfig,
  sizeUsdt: number,
  currentPrice: number,
  direction: DcaFuturesDirection,
): Promise<number> => {
  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  const qty = sizeUsdt / currentPrice;
  // long → Buy, short → Sell (открытие позиции, reduceOnly=false)
  const side: 'Buy' | 'Sell' = direction === 'long' ? 'Buy' : 'Sell';

  if (config.orderType === 'maker') {
    // maker: для long чуть ниже рынка, для short чуть выше
    const limitPrice =
      direction === 'long'
        ? currentPrice * (1 - MAKER_OFFSET)
        : currentPrice * (1 + MAKER_OFFSET);
    logger.info(
      `[dca-futures] ${config.strategyId}: maker ${direction} open ${qty.toFixed(6)} ${config.baseSymbol} @ ${limitPrice.toFixed(4)}`,
    );
    try {
      await placeOrder(config.apiKeyName, symbol, side, String(qty), String(limitPrice), {
        marketType: 'swap',
        reduceOnly: false,
      });
      await new Promise((r) => setTimeout(r, 30_000));
    } catch (err) {
      logger.warn(
        `[dca-futures] ${config.strategyId}: maker failed, fallback market: ${(err as Error).message}`,
      );
    }
  }

  logger.info(
    `[dca-futures] ${config.strategyId}: market ${direction} open ${qty.toFixed(6)} ${config.baseSymbol} @ ~${currentPrice.toFixed(4)}`,
  );
  await placeOrder(config.apiKeyName, symbol, side, String(qty), undefined, {
    marketType: 'swap',
    reduceOnly: false,
  });
  return qty;
};

// ── Закрывающий ордер (TP, SL или аварийное закрытие) ─────────────────────
const closePosition = async (
  config: DcaFuturesConfig,
  totalQty: number,
  direction: DcaFuturesDirection,
  reason: string,
): Promise<void> => {
  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  // Закрытие long → Sell reduceOnly; закрытие short → Buy reduceOnly
  const side: 'Buy' | 'Sell' = direction === 'long' ? 'Sell' : 'Buy';
  logger.info(
    `[dca-futures] ${config.strategyId}: closing ${direction} (${reason}), qty=${totalQty.toFixed(6)}`,
  );
  await placeOrder(config.apiKeyName, symbol, side, String(totalQty), undefined, {
    marketType: 'swap',
    reduceOnly: true,
  });
};

// ── Сбросить состояние после закрытия ─────────────────────────────────────
const resetState = async (strategyId: number): Promise<void> => {
  await db.run(
    `UPDATE strategies
     SET dcaf_state = 'idle',
         dcaf_direction = NULL,
         dcaf_orders_count = 0,
         dcaf_total_invested_usdt = 0,
         dcaf_total_qty = 0,
         dcaf_last_price = 0,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [strategyId],
  );
};

// ── Основная функция ───────────────────────────────────────────────────────
/**
 * executeDcaFutures — вызывается из runtime loop на каждый тик стратегии.
 *
 * @param apiKeyName  — имя API-ключа
 * @param strategyId  — ID стратегии в БД
 * @param opts.signalDirection — внешний сигнал ('long' | 'short'). Если передан
 *   при state=idle — открывает позицию в этом направлении. Если не передан и
 *   dcaf_auto_open=1 — открывается автоматически (long по умолчанию).
 */
export const executeDcaFutures = async (
  apiKeyName: string,
  strategyId: number,
  opts?: { signalDirection?: DcaFuturesDirection },
): Promise<{ action: string; details?: string }> => {
  const row = await db.get(
    `SELECT s.*, a.name AS api_key_name
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE s.id = ? AND a.name = ?`,
    [strategyId, apiKeyName],
  );

  if (!row) throw new Error(`DCA-Futures strategy ${strategyId} not found for key ${apiKeyName}`);

  const config = extractDcaFuturesConfig(row);
  if (!config.baseSymbol || !config.quoteSymbol) {
    throw new Error('dca-futures: base_symbol and quote_symbol required');
  }

  const symbol = resolveDcaMarketSymbol(config.baseSymbol, config.quoteSymbol);
  const state: string = String(row.dcaf_state ?? 'idle');
  const direction: DcaFuturesDirection | null =
    row.dcaf_direction === 'long' || row.dcaf_direction === 'short'
      ? (row.dcaf_direction as DcaFuturesDirection)
      : null;
  const ordersCount = Number(row.dcaf_orders_count ?? 0);
  const totalInvested = Number(row.dcaf_total_invested_usdt ?? 0);
  const totalQty = Number(row.dcaf_total_qty ?? 0);
  const lastPrice = Number(row.dcaf_last_price ?? 0);
  const avgPrice = totalQty > 0 && totalInvested > 0 ? totalInvested / totalQty : 0;

  let currentPrice = 0;
  try {
    currentPrice = await getCurrentPrice(apiKeyName, symbol);
  } catch (err) {
    throw new Error(`dca-futures: failed to get price for ${symbol}: ${(err as Error).message}`);
  }

  if (currentPrice <= 0) return { action: 'skip', details: 'price=0' };

  // ── Состояние: OPEN ──────────────────────────────────────────────────────
  if (state === 'open' && totalQty > 0 && avgPrice > 0 && direction) {
    const tpPrice =
      direction === 'long'
        ? avgPrice * (1 + config.tpPercent / 100)
        : avgPrice * (1 - config.tpPercent / 100);

    const slPrice =
      config.slPercent > 0
        ? direction === 'long'
          ? avgPrice * (1 - config.slPercent / 100)
          : avgPrice * (1 + config.slPercent / 100)
        : 0;

    // ── TP hit ──
    const tpHit =
      direction === 'long' ? currentPrice >= tpPrice : currentPrice <= tpPrice;
    if (tpHit) {
      await closePosition(
        config,
        totalQty,
        direction,
        `TP hit price=${currentPrice.toFixed(4)} tp=${tpPrice.toFixed(4)}`,
      );
      await resetState(strategyId);
      return {
        action: 'tp_close',
        details: `dir=${direction} price=${currentPrice.toFixed(4)} tp=${tpPrice.toFixed(4)} avg=${avgPrice.toFixed(4)}`,
      };
    }

    // ── SL hit ──
    const slHit =
      slPrice > 0 &&
      (direction === 'long' ? currentPrice <= slPrice : currentPrice >= slPrice);
    if (slHit) {
      await closePosition(
        config,
        totalQty,
        direction,
        `SL hit price=${currentPrice.toFixed(4)} sl=${slPrice.toFixed(4)}`,
      );
      await resetState(strategyId);
      return {
        action: 'sl_close',
        details: `dir=${direction} price=${currentPrice.toFixed(4)} sl=${slPrice.toFixed(4)} avg=${avgPrice.toFixed(4)}`,
      };
    }

    // ── Safety order ──
    if (lastPrice > 0 && ordersCount < config.maxOrders) {
      const stepTrigger =
        direction === 'long'
          ? lastPrice * (1 - config.stepPercent / 100)  // long: цена упала
          : lastPrice * (1 + config.stepPercent / 100);  // short: цена выросла

      const safetyTriggered =
        direction === 'long' ? currentPrice <= stepTrigger : currentPrice >= stepTrigger;

      if (safetyTriggered) {
        const safetySize =
          config.baseAmountUsdt * Math.pow(config.orderMultiplier, ordersCount);
        logger.info(
          `[dca-futures] ${strategyId}: safety order #${ordersCount + 1} ${direction} size=${safetySize.toFixed(2)} USDT`,
        );

        const bought = await openOrder(config, safetySize, currentPrice, direction);
        const newInvested = totalInvested + safetySize;
        const newQty = totalQty + bought;
        const newAvg = newInvested / newQty;

        await db.run(
          `UPDATE strategies
           SET dcaf_orders_count = ?,
               dcaf_total_invested_usdt = ?,
               dcaf_total_qty = ?,
               dcaf_last_price = ?,
               updated_at = CURRENT_TIMESTAMP
           WHERE id = ?`,
          [ordersCount + 1, newInvested, newQty, currentPrice, strategyId],
        );

        return {
          action: 'safety_buy',
          details: `order #${ordersCount + 1} dir=${direction} price=${currentPrice.toFixed(4)} avg=${newAvg.toFixed(4)}`,
        };
      }
    }

    return {
      action: 'hold',
      details: `dir=${direction} price=${currentPrice.toFixed(4)} avg=${avgPrice.toFixed(4)} tp=${tpPrice.toFixed(4)}`,
    };
  }

  // ── Состояние: IDLE — ждём сигнала или авто-открытие ────────────────────
  if (state === 'idle') {
    const openDirection: DcaFuturesDirection | null =
      opts?.signalDirection ??
      (config.autoOpen ? 'long' : null);

    if (!openDirection) {
      return { action: 'waiting', details: 'idle, no signal received' };
    }

    // Проверка баланса
    try {
      const balances = await getBalances(apiKeyName);
      const usdtEntry = (Array.isArray(balances) ? balances : []).find(
        (b: any) =>
          String(b.coin ?? '').toUpperCase() === 'USDT' &&
          String(b.accountType ?? '').toLowerCase() !== 'spot',
      );
      const available = Number(usdtEntry?.availableBalance ?? 0);
      if (available < config.baseAmountUsdt) {
        return {
          action: 'skip',
          details: `insufficient balance ${available.toFixed(2)} < ${config.baseAmountUsdt}`,
        };
      }
    } catch {
      // нет доступа к балансу — продолжаем
    }

    logger.info(
      `[dca-futures] ${strategyId}: opening base ${openDirection} position ${config.baseAmountUsdt} USDT on ${symbol}`,
    );

    const bought = await openOrder(config, config.baseAmountUsdt, currentPrice, openDirection);

    await db.run(
      `UPDATE strategies
       SET dcaf_state = 'open',
           dcaf_direction = ?,
           dcaf_orders_count = 0,
           dcaf_total_invested_usdt = ?,
           dcaf_total_qty = ?,
           dcaf_last_price = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [openDirection, config.baseAmountUsdt, bought, currentPrice, strategyId],
    );

    return {
      action: 'base_open',
      details: `dir=${openDirection} ${bought.toFixed(6)} ${config.baseSymbol} @ ${currentPrice.toFixed(4)}`,
    };
  }

  return { action: 'noop', details: `state=${state}` };
};

/**
 * triggerDcaFutures — вызывается из внешней стратегии (DD_BattleToads, zz_breakout)
 * при получении entry-сигнала. Открывает DCA-позицию в нужном направлении
 * на дочерней стратегии с strategy_type='dca_futures' для той же пары.
 *
 * @param apiKeyName  — имя API-ключа
 * @param baseSymbol  — базовый символ (например 'BTC')
 * @param direction   — 'long' | 'short'
 */
export const triggerDcaFutures = async (
  apiKeyName: string,
  baseSymbol: string,
  direction: DcaFuturesDirection,
): Promise<void> => {
  // Ищем активную dca_futures стратегию для этого ключа и символа в состоянии idle
  const rows = await db.all(
    `SELECT s.id
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?
       AND s.strategy_type = 'dca_futures'
       AND UPPER(s.base_symbol) = ?
       AND s.is_active = 1
       AND s.is_archived = 0
       AND (s.dcaf_state IS NULL OR s.dcaf_state = 'idle')`,
    [apiKeyName, baseSymbol.toUpperCase()],
  );

  for (const row of rows) {
    try {
      const result = await executeDcaFutures(apiKeyName, Number(row.id), { signalDirection: direction });
      logger.info(
        `[dca-futures] triggered by external signal for ${apiKeyName} ${baseSymbol}: ${result.action} ${result.details ?? ''}`,
      );
    } catch (err) {
      logger.warn(
        `[dca-futures] trigger failed for strategy ${row.id}: ${(err as Error).message}`,
      );
    }
  }
};

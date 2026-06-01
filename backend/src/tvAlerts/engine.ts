import logger from '../utils/logger';
import { db } from '../utils/database';
import {
  cancelTriggerOrders,
  closePosition,
  formatExchangeErrorForUser,
  getBalances,
  getPositions,
  initExchangeClient,
  placeOrder,
  placeTriggerOrder,
} from '../bot/exchange';
import { loadSettings } from '../config/settings';
import {
  getOpenPositionForAlert,
  getTvAlertById,
  getTvAlertsProfile,
  logTvAlertEvent,
} from './service';
import {
  ParsedTvSignal,
  TvAlertConfig,
  TvAlertRow,
  TvExitLeg,
  TvPositionRow,
  TvSignalConflictMode,
  parseTvAlertConfig,
} from './types';

const normalizeSymbol = (raw: string, fallback: string): string => {
  const text = String(raw || '').trim().toUpperCase();
  if (!text) {
    return fallback.toUpperCase();
  }
  if (text.includes('/')) {
    return text.replace('/', '').replace(':USDT', 'USDT');
  }
  if (!text.endsWith('USDT') && !text.endsWith('USD')) {
    return `${text}USDT`;
  }
  return text;
};

export const parseTradingViewPayload = (body: unknown, defaultSymbol: string): ParsedTvSignal => {
  let data: Record<string, unknown> = {};
  if (typeof body === 'string') {
    const trimmed = body.trim();
    try {
      data = JSON.parse(trimmed);
    } catch {
      const lower = trimmed.toLowerCase();
      if (/close|flat|exit/.test(lower)) {
        return { action: lower.includes('long') ? 'close_long' : lower.includes('short') ? 'close_short' : 'close', raw: { text: trimmed } };
      }
      if (/short|sell/.test(lower)) {
        return { action: 'short', symbol: defaultSymbol, raw: { text: trimmed } };
      }
      if (/long|buy/.test(lower)) {
        return { action: 'long', symbol: defaultSymbol, raw: { text: trimmed } };
      }
      return { action: 'long', symbol: defaultSymbol, raw: { text: trimmed } };
    }
  } else if (body && typeof body === 'object') {
    data = body as Record<string, unknown>;
  }

  const actionRaw = String(
    data.action || data.side || data.signal || data.order || data.type || ''
  ).trim().toLowerCase();

  let action: ParsedTvSignal['action'] = 'long';
  if (/close.*long|exit.*long/.test(actionRaw)) {
    action = 'close_long';
  } else if (/close.*short|exit.*short/.test(actionRaw)) {
    action = 'close_short';
  } else if (/close|flat|exit/.test(actionRaw)) {
    action = 'close';
  } else if (/short|sell/.test(actionRaw)) {
    action = 'short';
  } else if (/long|buy/.test(actionRaw)) {
    action = 'long';
  }

  const symbol = normalizeSymbol(
    String(data.symbol || data.ticker || data.pair || ''),
    defaultSymbol,
  );

  const qty = data.qty || data.quantity || data.size;
  const price = Number(data.price || data.close || data.market_price);

  return {
    action,
    symbol,
    qty: qty !== undefined ? String(qty) : undefined,
    price: Number.isFinite(price) && price > 0 ? price : undefined,
    raw: data,
  };
};

const resolveApiKeyName = async (alert: TvAlertRow): Promise<string> => {
  const fromAlert = String(alert.api_key_name || '').trim();
  if (fromAlert) {
    return fromAlert;
  }
  const profile = await getTvAlertsProfile(alert.tenant_id);
  const fromProfile = String(profile?.default_api_key_name || '').trim();
  if (!fromProfile) {
    throw new Error('No API key configured for this alert. Add exchange keys in the cabinet.');
  }
  return fromProfile;
};

const ensureClientReady = async (apiKeyName: string): Promise<void> => {
  const { apiKeys } = await loadSettings();
  const key = apiKeys.find((item) => item.name === apiKeyName);
  if (!key) {
    throw new Error(`API key "${apiKeyName}" not found`);
  }
  initExchangeClient(key);
};

const getUsdtAvailable = async (apiKeyName: string): Promise<number> => {
  const balances = await getBalances(apiKeyName);
  const usdt = balances.find((row) => String(row.coin || '').toUpperCase() === 'USDT');
  const available = Number.parseFloat(String(usdt?.availableBalance || usdt?.walletBalance || '0'));
  return Number.isFinite(available) && available > 0 ? available : 0;
};

const getReferencePrice = async (apiKeyName: string, symbol: string): Promise<number> => {
  const positions = await getPositions(apiKeyName, symbol);
  const open = positions.find((p) => Number.parseFloat(String(p?.size || '0')) > 0);
  const mark = Number.parseFloat(String(open?.markPrice || '0'));
  if (Number.isFinite(mark) && mark > 0) {
    return mark;
  }

  const candles = await import('../bot/exchange').then((m) => m.getMarketData(apiKeyName, symbol, '1m', 2));
  const last = Array.isArray(candles) && candles.length > 0 ? candles[candles.length - 1] : null;
  const lastBar = last as { close?: number } | number[] | null;
  const close = Array.isArray(lastBar)
    ? Number(lastBar[4])
    : Number((lastBar as { close?: number })?.close);
  if (Number.isFinite(close) && close > 0) {
    return close;
  }
  throw new Error(`Unable to resolve market price for ${symbol}`);
};

const computeOrderQty = async (
  apiKeyName: string,
  symbol: string,
  alert: TvAlertRow,
  overrideQty?: string,
): Promise<string> => {
  if (overrideQty) {
    return overrideQty;
  }

  const price = await getReferencePrice(apiKeyName, symbol);
  let notional = 0;
  if (alert.lot_mode === 'percent_deposit') {
    const available = await getUsdtAvailable(apiKeyName);
    notional = available * (Math.max(0.1, Number(alert.lot_value) || 1) / 100);
  } else {
    notional = Math.max(1, Number(alert.lot_value) || 100);
  }

  const leverage = Math.max(1, Number(alert.leverage) || 1);
  const effectiveNotional = notional * leverage;
  const qty = effectiveNotional / price;
  if (!Number.isFinite(qty) || qty <= 0) {
    throw new Error('Computed order size is zero. Check balance and lot settings.');
  }
  return qty.toFixed(6).replace(/\.?0+$/, '');
};

const calcTriggerPrice = (
  side: 'Buy' | 'Sell',
  entryPrice: number,
  leg: TvExitLeg,
): number => {
  const offset = Number(leg.priceOffsetPercent || 0) / 100;
  const move = Number(leg.percent || 1) / 100;
  const isLong = side === 'Buy';

  if (leg.kind === 'sl') {
    if (isLong) {
      return entryPrice * (1 - move - offset);
    }
    return entryPrice * (1 + move + offset);
  }

  // take profit
  if (isLong) {
    return entryPrice * (1 + move + offset);
  }
  return entryPrice * (1 - move - offset);
};

const placeExitLegOrders = async (
  apiKeyName: string,
  symbol: string,
  positionSide: 'Buy' | 'Sell',
  totalQty: string,
  entryPrice: number,
  config: TvAlertConfig,
): Promise<string[]> => {
  const legs = (config.exitLegs || []).filter((leg) => leg.mode === 'percent');
  if (legs.length === 0) {
    return [];
  }

  const closeSide: 'Buy' | 'Sell' = positionSide === 'Buy' ? 'Sell' : 'Buy';
  const total = Number.parseFloat(totalQty);
  const orderIds: string[] = [];

  for (const leg of legs) {
    const legQty = (total * Math.max(0.1, Math.min(100, leg.closePercent || 100))) / 100;
    if (!Number.isFinite(legQty) || legQty <= 0) {
      continue;
    }
    const qtyStr = legQty.toFixed(6).replace(/\.?0+$/, '');
    const triggerPrice = calcTriggerPrice(positionSide, entryPrice, leg);
    try {
      await placeTriggerOrder(
        apiKeyName,
        symbol,
        closeSide,
        qtyStr,
        triggerPrice,
        `${leg.kind}_${leg.id}`,
      );
      orderIds.push(`${leg.kind}:${triggerPrice}`);
    } catch (error) {
      logger.warn(`[tvAlerts] Failed to place ${leg.kind} leg for ${symbol}: ${(error as Error).message}`);
    }
  }

  return orderIds;
};

const upsertOpenPosition = async (
  alert: TvAlertRow,
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  entryPrice: number,
  config: TvAlertConfig,
  exchangeOrderMeta: Record<string, unknown>,
): Promise<number> => {
  const exitOrderIds = await placeExitLegOrders(apiKeyName, symbol, side, qty, entryPrice, config);
  const trailingLegs = (config.exitLegs || []).filter((leg) => leg.mode === 'trailing');

  const state = {
    exitOrderIds,
    trailingLegs,
    trailingAnchor: entryPrice,
    config,
  };

  const result = await db.run(
    `INSERT INTO tv_alert_positions (
       alert_id, tenant_id, api_key_name, symbol, side, status,
       entry_price, qty, remaining_qty, state_json, opened_at
     ) VALUES (?, ?, ?, ?, ?, 'open', ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      alert.id,
      alert.tenant_id,
      apiKeyName,
      symbol,
      side,
      entryPrice,
      qty,
      qty,
      JSON.stringify(state),
    ]
  );

  return Number((result as { lastID?: number }).lastID || 0);
};

const closeAlertPosition = async (
  position: TvPositionRow,
  percent = 100,
): Promise<void> => {
  const apiKeyName = position.api_key_name;
  const symbol = position.symbol;
  const side = position.side as 'Buy' | 'Sell';

  await ensureClientReady(apiKeyName);
  await cancelTriggerOrders(apiKeyName, symbol);

  const positions = await getPositions(apiKeyName, symbol);
  const live = positions.find((p) => {
    const sameSymbol = String(p?.symbol || '').toUpperCase() === symbol.toUpperCase();
    const hasSize = Number.parseFloat(String(p?.size || '0')) > 0;
    return sameSymbol && hasSize;
  });

  if (!live) {
    await db.run(
      `UPDATE tv_alert_positions
       SET status = 'closed', remaining_qty = '0', closed_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [position.id]
    );
    return;
  }

  const totalSize = Number.parseFloat(String(live.size || '0'));
  const safePercent = Math.max(0.1, Math.min(100, percent));
  const qtyToClose = ((totalSize * safePercent) / 100).toFixed(8).replace(/\.?0+$/, '');
  await closePosition(apiKeyName, symbol, qtyToClose, live.side as 'Buy' | 'Sell');

  const remaining = Math.max(0, totalSize - Number.parseFloat(qtyToClose));
  const isFullClose = safePercent >= 99.9 || remaining <= 0;

  await db.run(
    `UPDATE tv_alert_positions
     SET remaining_qty = ?,
         status = ?,
         closed_at = CASE WHEN ? = 'closed' THEN CURRENT_TIMESTAMP ELSE closed_at END
     WHERE id = ?`,
    [
      String(remaining),
      isFullClose ? 'closed' : 'open',
      isFullClose ? 'closed' : 'open',
      position.id,
    ]
  );
};

const handleConflict = async (
  mode: TvSignalConflictMode,
  openPosition: TvPositionRow,
  signal: ParsedTvSignal,
  alert: TvAlertRow,
  apiKeyName: string,
): Promise<'proceed' | 'queued' | 'replaced'> => {
  if (mode === 'accept_new') {
    return 'proceed';
  }
  if (mode === 'close_and_open') {
    await closeAlertPosition(openPosition, 100);
    return 'replaced';
  }
  // wait_close
  await logTvAlertEvent({
    tenantId: alert.tenant_id,
    alertId: alert.id,
    positionId: openPosition.id,
    source: 'webhook',
    action: signal.action,
    status: 'queued_conflict',
    body: { signal, mode },
  });
  return 'queued';
};

export const processTradingViewWebhook = async (
  tenantSlug: string,
  alertSlug: string,
  secret: string,
  body: unknown,
): Promise<{ ok: boolean; message: string; details?: Record<string, unknown> }> => {
  const { getTvAlertByWebhook } = await import('./service');
  const alert = await getTvAlertByWebhook(tenantSlug, alertSlug, secret);
  if (!alert) {
    return { ok: false, message: 'Invalid webhook URL or disabled alert' };
  }

  const profile = await getTvAlertsProfile(alert.tenant_id);
  if (profile && !profile.enabled) {
    return { ok: false, message: 'TV alerts workspace is disabled' };
  }

  const signal = parseTradingViewPayload(body, alert.symbol);
  const config = parseTvAlertConfig(alert.config_json);
  const symbol = normalizeSymbol(signal.symbol || '', alert.symbol);

  const eventId = await logTvAlertEvent({
    tenantId: alert.tenant_id,
    alertId: alert.id,
    source: 'webhook',
    action: signal.action,
    status: 'received',
    body: signal.raw,
  });

  try {
    const apiKeyName = await resolveApiKeyName(alert);
    await ensureClientReady(apiKeyName);

    const openPosition = await getOpenPositionForAlert(alert.id);
    const conflictMode = (profile?.signal_conflict_mode || 'wait_close') as TvSignalConflictMode;

    if (signal.action === 'close' || signal.action === 'close_long' || signal.action === 'close_short') {
      if (!openPosition) {
        await logTvAlertEvent({
          tenantId: alert.tenant_id,
          alertId: alert.id,
          source: 'webhook',
          action: signal.action,
          status: 'ignored',
          body: { reason: 'no_open_position' },
        });
        return { ok: true, message: 'No open position to close' };
      }
      await closeAlertPosition(openPosition, 100);
      await logTvAlertEvent({
        tenantId: alert.tenant_id,
        alertId: alert.id,
        positionId: openPosition.id,
        source: 'webhook',
        action: signal.action,
        status: 'closed',
        body: {},
      });
      return { ok: true, message: 'Position closed' };
    }

    const targetSide: 'Buy' | 'Sell' = signal.action === 'short' ? 'Sell' : 'Buy';

    if (openPosition) {
      const sameDirection = openPosition.side === targetSide;
      if (sameDirection) {
        return { ok: true, message: 'Already in position for this direction' };
      }

      if (config.closeOnOppositeSignal !== false) {
        await closeAlertPosition(openPosition, 100);
      } else {
        const conflict = await handleConflict(conflictMode, openPosition, signal, alert, apiKeyName);
        if (conflict === 'queued') {
          return { ok: true, message: 'Signal queued: waiting for position close' };
        }
      }
    } else {
      const stillOpen = await getOpenPositionForAlert(alert.id);
      if (stillOpen) {
        const conflict = await handleConflict(conflictMode, stillOpen, signal, alert, apiKeyName);
        if (conflict === 'queued') {
          return { ok: true, message: 'Signal queued: waiting for position close' };
        }
      }
    }

    const qty = await computeOrderQty(apiKeyName, symbol, alert, signal.qty);
    const entryPrice = signal.price || await getReferencePrice(apiKeyName, symbol);

    await placeOrder(apiKeyName, symbol, targetSide, qty, undefined, {
      marketType: config.marketType === 'spot' ? 'spot' : 'swap',
    });

    const positionId = await upsertOpenPosition(
      alert,
      apiKeyName,
      symbol,
      targetSide,
      qty,
      entryPrice,
      config,
      {},
    );

    await logTvAlertEvent({
      tenantId: alert.tenant_id,
      alertId: alert.id,
      positionId,
      source: 'webhook',
      action: signal.action,
      status: 'executed',
      body: { symbol, qty, side: targetSide, entryPrice, eventId },
    });

    return {
      ok: true,
      message: `Opened ${signal.action} ${symbol}`,
      details: { symbol, qty, side: targetSide, positionId },
    };
  } catch (error) {
    const message = formatExchangeErrorForUser(error);
    await logTvAlertEvent({
      tenantId: alert.tenant_id,
      alertId: alert.id,
      source: 'webhook',
      action: signal.action,
      status: 'error',
      body: signal.raw,
      errorMessage: message,
    });
    logger.error(`[tvAlerts] Webhook error: ${message}`);
    return { ok: false, message };
  }
};

export const runTvAlertsMonitorCycle = async (): Promise<void> => {
  const rows = await db.all(
    `SELECT p.*, a.config_json
     FROM tv_alert_positions p
     JOIN tv_alerts a ON a.id = p.alert_id
     WHERE p.status = 'open'`
  ) as Array<TvPositionRow & { config_json: string }>;

  for (const row of rows) {
    try {
      const config = parseTvAlertConfig(row.config_json);
      const state = (() => {
        try {
          return JSON.parse(row.state_json || '{}') as {
            trailingLegs?: TvExitLeg[];
            trailingAnchor?: number;
          };
        } catch {
          return {};
        }
      })();

      const trailingLegs = state.trailingLegs || [];
      if (trailingLegs.length === 0) {
        continue;
      }

      await ensureClientReady(row.api_key_name);
      const price = await getReferencePrice(row.api_key_name, row.symbol);
      const isLong = row.side === 'Buy';
      let anchor = Number(state.trailingAnchor) || Number(row.entry_price) || price;

      if (isLong) {
        anchor = Math.max(anchor, price);
      } else {
        anchor = Math.min(anchor, price);
      }

      for (const leg of trailingLegs) {
        const trailPct = Number(leg.percent || 1) / 100;
        const stop = isLong ? anchor * (1 - trailPct) : anchor * (1 + trailPct);
        const hit = isLong ? price <= stop : price >= stop;
        if (!hit) {
          continue;
        }

        const closePct = Math.max(0.1, Math.min(100, leg.closePercent || 100));
        await closeAlertPosition(row, closePct);
        await logTvAlertEvent({
          tenantId: row.tenant_id,
          alertId: row.alert_id,
          positionId: row.id,
          source: 'monitor',
          action: 'trailing_exit',
          status: 'executed',
          body: { legId: leg.id, price, stop, anchor },
        });
        break;
      }

      await db.run(
        'UPDATE tv_alert_positions SET state_json = ? WHERE id = ?',
        [JSON.stringify({ ...state, trailingAnchor: anchor }), row.id]
      );
    } catch (error) {
      logger.warn(`[tvAlerts] Monitor tick failed for position ${row.id}: ${(error as Error).message}`);
    }
  }
};

export const manualTvTerminalAction = async (
  tenantId: number,
  alertId: number,
  action: 'open_long' | 'open_short' | 'close_partial' | 'close_all' | 'cancel_orders',
  options?: { percent?: number; qty?: string },
): Promise<Record<string, unknown>> => {
  const alert = await getTvAlertById(tenantId, alertId);
  if (!alert) {
    throw new Error('Alert not found');
  }

  const apiKeyName = await resolveApiKeyName(alert);
  await ensureClientReady(apiKeyName);
  const symbol = alert.symbol;
  const config = alert.config;

  if (action === 'cancel_orders') {
    await cancelTriggerOrders(apiKeyName, symbol);
    return { success: true, action };
  }

  const openPosition = await getOpenPositionForAlert(alertId);

  if (action === 'close_all' || action === 'close_partial') {
    if (!openPosition) {
      throw new Error('No open position');
    }
    const percent = action === 'close_all' ? 100 : Math.max(0.1, Math.min(100, Number(options?.percent) || 50));
    await closeAlertPosition(openPosition, percent);
    await logTvAlertEvent({
      tenantId,
      alertId,
      positionId: openPosition.id,
      source: 'manual',
      action,
      status: 'executed',
      body: { percent },
    });
    return { success: true, action, percent };
  }

  if (action === 'open_long' || action === 'open_short') {
    if (openPosition) {
      throw new Error('Close existing position before manual open');
    }
    const side: 'Buy' | 'Sell' = action === 'open_short' ? 'Sell' : 'Buy';
    const qty = await computeOrderQty(apiKeyName, symbol, alert, options?.qty);
    const entryPrice = await getReferencePrice(apiKeyName, symbol);
    await placeOrder(apiKeyName, symbol, side, qty, undefined, {
      marketType: config.marketType === 'spot' ? 'spot' : 'swap',
    });
    const positionId = await upsertOpenPosition(alert, apiKeyName, symbol, side, qty, entryPrice, config, {});
    await logTvAlertEvent({
      tenantId,
      alertId,
      positionId,
      source: 'manual',
      action,
      status: 'executed',
      body: { qty, side },
    });
    return { success: true, action, qty, side, positionId };
  }

  throw new Error('Unknown terminal action');
};

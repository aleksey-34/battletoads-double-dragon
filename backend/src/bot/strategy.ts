import { Strategy } from '../config/settings';
import {
  applySymbolRiskSettings,
  cancelAllOrders,
  closePosition,
  getBalances,
  getAllSymbols,
  getInstrumentInfo,
  getMarketData,
  getPositions,
  placeOrder,
} from './exchange';
import { calculateSyntheticOHLC } from './synthetic';
import logger from '../utils/logger';

type StrategySignal = 'long' | 'short' | 'none';

type StrategyDraft = Partial<Strategy> & {
  name?: string;
};

type ChartBindingOverride = {
  base?: string;
  quote?: string;
  interval?: string;
  baseCoef?: number;
  quoteCoef?: number;
};

type ParsedSyntheticCandle = {
  timeMs: number;
  open: number;
  high: number;
  low: number;
  close: number;
};

const DEFAULT_STRATEGY: Omit<Strategy, 'api_key_id' | 'id'> = {
  name: 'DD_BattleToads',
  strategy_type: 'DD_BattleToads',
  is_active: true,
  display_on_chart: true,
  show_settings: true,
  show_chart: true,
  show_indicators: true,
  show_positions_on_chart: true,
  show_values_each_bar: false,
  auto_update: true,
  take_profit_percent: 7.5,
  price_channel_length: 50,
  detection_source: 'close',
  base_symbol: 'BTCUSDT',
  quote_symbol: 'ETHUSDT',
  interval: '1h',
  base_coef: 1,
  quote_coef: 1,
  long_enabled: true,
  short_enabled: true,
  lot_long_percent: 100,
  lot_short_percent: 100,
  max_deposit: 1000,
  margin_type: 'cross',
  leverage: 1,
  fixed_lot: false,
  reinvest_percent: 0,
  state: 'flat',
  entry_ratio: null,
  last_signal: null,
  last_action: null,
  last_error: null,
};

const safeBoolean = (value: any, fallback: boolean): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return fallback;
};

const safeNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeSymbol = (value: string): string => String(value || '').trim().toUpperCase();

const normalizeSymbolKey = (value: any): string => {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
};

const normalizeStrategy = (row: any): Strategy => {
  return {
    id: Number(row.id),
    name: String(row.name || DEFAULT_STRATEGY.name),
    api_key_id: Number(row.api_key_id),
    strategy_type: 'DD_BattleToads',
    is_active: safeBoolean(row.is_active, true),
    display_on_chart: safeBoolean(row.display_on_chart, true),
    show_settings: safeBoolean(row.show_settings, true),
    show_chart: safeBoolean(row.show_chart, true),
    show_indicators: safeBoolean(row.show_indicators, true),
    show_positions_on_chart: safeBoolean(row.show_positions_on_chart, true),
    show_values_each_bar: safeBoolean(row.show_values_each_bar, false),
    auto_update: safeBoolean(row.auto_update, true),
    take_profit_percent: safeNumber(row.take_profit_percent, DEFAULT_STRATEGY.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(row.price_channel_length, DEFAULT_STRATEGY.price_channel_length))),
    detection_source: String(row.detection_source || DEFAULT_STRATEGY.detection_source) === 'wick' ? 'wick' : 'close',
    base_symbol: normalizeSymbol(String(row.base_symbol || DEFAULT_STRATEGY.base_symbol)),
    quote_symbol: normalizeSymbol(String(row.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
    interval: String(row.interval || DEFAULT_STRATEGY.interval),
    base_coef: safeNumber(row.base_coef, DEFAULT_STRATEGY.base_coef),
    quote_coef: safeNumber(row.quote_coef, DEFAULT_STRATEGY.quote_coef),
    long_enabled: safeBoolean(row.long_enabled, true),
    short_enabled: safeBoolean(row.short_enabled, true),
    lot_long_percent: safeNumber(row.lot_long_percent, DEFAULT_STRATEGY.lot_long_percent),
    lot_short_percent: safeNumber(row.lot_short_percent, DEFAULT_STRATEGY.lot_short_percent),
    max_deposit: safeNumber(row.max_deposit, DEFAULT_STRATEGY.max_deposit),
    margin_type: String(row.margin_type || DEFAULT_STRATEGY.margin_type) === 'isolated' ? 'isolated' : 'cross',
    leverage: Math.max(1, safeNumber(row.leverage, DEFAULT_STRATEGY.leverage)),
    fixed_lot: safeBoolean(row.fixed_lot, false),
    reinvest_percent: safeNumber(row.reinvest_percent, DEFAULT_STRATEGY.reinvest_percent),
    state: String(row.state || 'flat') === 'long' ? 'long' : String(row.state || 'flat') === 'short' ? 'short' : 'flat',
    entry_ratio: row.entry_ratio === null || row.entry_ratio === undefined ? null : safeNumber(row.entry_ratio, 0),
    last_signal: row.last_signal === undefined ? null : row.last_signal,
    last_action: row.last_action === undefined ? null : row.last_action,
    last_error: row.last_error === undefined ? null : row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const { db } = await import('../utils/database');
  const keyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!keyRow) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(keyRow.id);
};

const getStrategyRow = async (apiKeyName: string, strategyId: number): Promise<any> => {
  const { db } = await import('../utils/database');
  const row = await db.get(
    `SELECT s.*
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ? AND s.id = ?`,
    [apiKeyName, strategyId]
  );

  if (!row) {
    throw new Error(`Strategy not found: ${strategyId}`);
  }

  return row;
};

const writeStrategy = async (strategy: Strategy): Promise<void> => {
  const { db } = await import('../utils/database');
  await db.run(
    `UPDATE strategies SET
      name = ?,
      strategy_type = ?,
      is_active = ?,
      display_on_chart = ?,
      show_settings = ?,
      show_chart = ?,
      show_indicators = ?,
      show_positions_on_chart = ?,
      show_values_each_bar = ?,
      auto_update = ?,
      take_profit_percent = ?,
      price_channel_length = ?,
      detection_source = ?,
      base_symbol = ?,
      quote_symbol = ?,
      interval = ?,
      base_coef = ?,
      quote_coef = ?,
      long_enabled = ?,
      short_enabled = ?,
      lot_long_percent = ?,
      lot_short_percent = ?,
      max_deposit = ?,
      margin_type = ?,
      leverage = ?,
      fixed_lot = ?,
      reinvest_percent = ?,
      state = ?,
      entry_ratio = ?,
      last_signal = ?,
      last_action = ?,
      last_error = ?,
      updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND api_key_id = ?`,
    [
      strategy.name,
      'DD_BattleToads',
      strategy.is_active ? 1 : 0,
      strategy.display_on_chart ? 1 : 0,
      strategy.show_settings ? 1 : 0,
      strategy.show_chart ? 1 : 0,
      strategy.show_indicators ? 1 : 0,
      strategy.show_positions_on_chart ? 1 : 0,
      strategy.show_values_each_bar ? 1 : 0,
      strategy.auto_update ? 1 : 0,
      strategy.take_profit_percent,
      strategy.price_channel_length,
      strategy.detection_source,
      strategy.base_symbol,
      strategy.quote_symbol,
      strategy.interval,
      strategy.base_coef,
      strategy.quote_coef,
      strategy.long_enabled ? 1 : 0,
      strategy.short_enabled ? 1 : 0,
      strategy.lot_long_percent,
      strategy.lot_short_percent,
      strategy.max_deposit,
      strategy.margin_type,
      strategy.leverage,
      strategy.fixed_lot ? 1 : 0,
      strategy.reinvest_percent,
      strategy.state || 'flat',
      strategy.entry_ratio ?? null,
      strategy.last_signal ?? null,
      strategy.last_action ?? null,
      strategy.last_error ?? null,
      strategy.id,
      strategy.api_key_id,
    ]
  );
};

const parseSyntheticCandle = (item: any): ParsedSyntheticCandle | null => {
  const timeMs = Number(item?.time);
  const open = Number(item?.open);
  const high = Number(item?.high);
  const low = Number(item?.low);
  const close = Number(item?.close);

  if (!Number.isFinite(timeMs) || !Number.isFinite(open) || !Number.isFinite(high) || !Number.isFinite(low) || !Number.isFinite(close)) {
    return null;
  }

  return { timeMs, open, high, low, close };
};

const getLatestMarketClose = async (apiKeyName: string, symbol: string): Promise<number> => {
  const payload = await getMarketData(apiKeyName, symbol, '1m', 5);
  const parsed = (Array.isArray(payload) ? payload : [])
    .map((item: any) => {
      if (!Array.isArray(item) || item.length < 5) {
        return null;
      }
      const timeMs = Number(item[0]);
      const close = Number(item[4]);
      if (!Number.isFinite(timeMs) || !Number.isFinite(close)) {
        return null;
      }
      return { timeMs, close };
    })
    .filter((item): item is { timeMs: number; close: number } => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);

  const latest = parsed[parsed.length - 1];
  if (!latest) {
    throw new Error(`No market data for ${symbol}`);
  }

  return latest.close;
};

const extractUsdtBalance = (balances: any[]): number => {
  const list = Array.isArray(balances) ? balances : [];
  const usdt = list.find((item: any) => String(item?.coin || '').toUpperCase() === 'USDT');

  if (usdt) {
    const available = Number.parseFloat(String(usdt.availableBalance ?? '0'));
    const wallet = Number.parseFloat(String(usdt.walletBalance ?? '0'));
    const fromUsdt = Number.isFinite(available) && available > 0 ? available : wallet;
    if (Number.isFinite(fromUsdt) && fromUsdt > 0) {
      return fromUsdt;
    }
  }

  const fallbackUsd = list
    .map((item: any) => Number.parseFloat(String(item?.usdValue ?? '0')))
    .filter((value: number) => Number.isFinite(value) && value > 0)
    .reduce((acc: number, value: number) => acc + value, 0);

  return Number.isFinite(fallbackUsd) && fallbackUsd > 0 ? fallbackUsd : 0;
};

const decimalPlaces = (value: string): number => {
  const normalized = String(value || '');
  if (!normalized.includes('.')) {
    return 0;
  }
  return normalized.split('.')[1].replace(/0+$/, '').length;
};

const normalizeQtyByStep = async (apiKeyName: string, symbol: string, rawQty: number): Promise<string> => {
  if (!Number.isFinite(rawQty) || rawQty <= 0) {
    throw new Error(`Invalid qty for ${symbol}`);
  }

  const info = await getInstrumentInfo(apiKeyName, symbol);
  const qtyStepRaw = String(info?.lotSizeFilter?.qtyStep || '0.001');
  const minQtyRaw = String(info?.lotSizeFilter?.minOrderQty || '0');

  const qtyStep = Number.parseFloat(qtyStepRaw);
  const minQty = Number.parseFloat(minQtyRaw);

  let normalized = rawQty;
  if (Number.isFinite(qtyStep) && qtyStep > 0) {
    normalized = Math.floor(rawQty / qtyStep) * qtyStep;
  }

  if (Number.isFinite(minQty) && minQty > 0) {
    normalized = Math.max(normalized, minQty);
  }

  if (!Number.isFinite(normalized) || normalized <= 0) {
    throw new Error(`Normalized qty is invalid for ${symbol}`);
  }

  const decimals = Math.max(0, decimalPlaces(qtyStepRaw));
  return normalized.toFixed(decimals).replace(/\.?0+$/, '');
};

const computeSignal = (
  candles: ParsedSyntheticCandle[],
  length: number,
  detectionSource: 'wick' | 'close',
  longEnabled: boolean,
  shortEnabled: boolean
): { signal: StrategySignal; currentRatio: number; donchianHigh: number; donchianLow: number; donchianCenter: number } => {
  if (candles.length < length + 1) {
    throw new Error(`Not enough candles for Donchian channel: need ${length + 1}, got ${candles.length}`);
  }

  const current = candles[candles.length - 1];
  const window = candles.slice(candles.length - 1 - length, candles.length - 1);

  if (window.length === 0) {
    throw new Error('Donchian window is empty');
  }

  const highs = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.high);
  const lows = detectionSource === 'close' ? window.map((item) => item.close) : window.map((item) => item.low);

  const donchianHigh = Math.max(...highs);
  const donchianLow = Math.min(...lows);
  const donchianCenter = (donchianHigh + donchianLow) / 2;

  const longBreakout = detectionSource === 'close' ? current.close >= donchianHigh : current.high >= donchianHigh;
  const shortBreakout = detectionSource === 'close' ? current.close <= donchianLow : current.low <= donchianLow;

  if (longEnabled && longBreakout) {
    return {
      signal: 'long',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (shortEnabled && shortBreakout) {
    return {
      signal: 'short',
      currentRatio: current.close,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  return {
    signal: 'none',
    currentRatio: current.close,
    donchianHigh,
    donchianLow,
    donchianCenter,
  };
};

const closeAllForSymbol = async (apiKeyName: string, symbol: string): Promise<void> => {
  const positions = await getPositions(apiKeyName, symbol);
  const relevant = positions.filter((position: any) => {
    return (
      String(position?.symbol || '').toUpperCase() === symbol.toUpperCase() &&
      Number.parseFloat(String(position?.size || '0')) > 0
    );
  });

  for (const position of relevant) {
    await closePosition(apiKeyName, symbol, String(position.size), position.side as 'Buy' | 'Sell');
  }
};

const inferSyntheticStateFromPair = (
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

const formatActionError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const getStrategies = async (apiKeyName: string): Promise<Strategy[]> => {
  const { db } = await import('../utils/database');
  const rows = await db.all(
    `SELECT s.*
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?
     ORDER BY s.id DESC`,
    [apiKeyName]
  );

  return rows.map(normalizeStrategy);
};

export const createStrategy = async (apiKeyName: string, draft: StrategyDraft): Promise<Strategy> => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);

  const strategy: Strategy = {
    ...DEFAULT_STRATEGY,
    name: String(draft.name || DEFAULT_STRATEGY.name),
    api_key_id: apiKeyId,
    strategy_type: 'DD_BattleToads',
    is_active: safeBoolean(draft.is_active, DEFAULT_STRATEGY.is_active),
    display_on_chart: safeBoolean(draft.display_on_chart, DEFAULT_STRATEGY.display_on_chart),
    show_settings: safeBoolean(draft.show_settings, DEFAULT_STRATEGY.show_settings),
    show_chart: safeBoolean(draft.show_chart, DEFAULT_STRATEGY.show_chart),
    show_indicators: safeBoolean(draft.show_indicators, DEFAULT_STRATEGY.show_indicators),
    show_positions_on_chart: safeBoolean(draft.show_positions_on_chart, DEFAULT_STRATEGY.show_positions_on_chart),
    show_values_each_bar: safeBoolean(draft.show_values_each_bar, DEFAULT_STRATEGY.show_values_each_bar),
    auto_update: safeBoolean(draft.auto_update, DEFAULT_STRATEGY.auto_update),
    take_profit_percent: safeNumber(draft.take_profit_percent, DEFAULT_STRATEGY.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(draft.price_channel_length, DEFAULT_STRATEGY.price_channel_length))),
    detection_source: draft.detection_source === 'wick' ? 'wick' : 'close',
    base_symbol: normalizeSymbol(String(draft.base_symbol || DEFAULT_STRATEGY.base_symbol)),
    quote_symbol: normalizeSymbol(String(draft.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
    interval: String(draft.interval || DEFAULT_STRATEGY.interval),
    base_coef: safeNumber(draft.base_coef, DEFAULT_STRATEGY.base_coef),
    quote_coef: safeNumber(draft.quote_coef, DEFAULT_STRATEGY.quote_coef),
    long_enabled: safeBoolean(draft.long_enabled, DEFAULT_STRATEGY.long_enabled),
    short_enabled: safeBoolean(draft.short_enabled, DEFAULT_STRATEGY.short_enabled),
    lot_long_percent: safeNumber(draft.lot_long_percent, DEFAULT_STRATEGY.lot_long_percent),
    lot_short_percent: safeNumber(draft.lot_short_percent, DEFAULT_STRATEGY.lot_short_percent),
    max_deposit: safeNumber(draft.max_deposit, DEFAULT_STRATEGY.max_deposit),
    margin_type: draft.margin_type === 'isolated' ? 'isolated' : 'cross',
    leverage: Math.max(1, safeNumber(draft.leverage, DEFAULT_STRATEGY.leverage)),
    fixed_lot: safeBoolean(draft.fixed_lot, DEFAULT_STRATEGY.fixed_lot),
    reinvest_percent: safeNumber(draft.reinvest_percent, DEFAULT_STRATEGY.reinvest_percent),
    state: 'flat',
    entry_ratio: null,
    last_signal: null,
    last_action: null,
    last_error: null,
  };

  const result: any = await db.run(
    `INSERT INTO strategies (
      name,
      api_key_id,
      strategy_type,
      is_active,
      display_on_chart,
      show_settings,
      show_chart,
      show_indicators,
      show_positions_on_chart,
      show_values_each_bar,
      auto_update,
      take_profit_percent,
      price_channel_length,
      detection_source,
      base_symbol,
      quote_symbol,
      interval,
      base_coef,
      quote_coef,
      long_enabled,
      short_enabled,
      lot_long_percent,
      lot_short_percent,
      max_deposit,
      margin_type,
      leverage,
      fixed_lot,
      reinvest_percent,
      state,
      entry_ratio,
      last_signal,
      last_action,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      strategy.name,
      strategy.api_key_id,
      strategy.strategy_type,
      strategy.is_active ? 1 : 0,
      strategy.display_on_chart ? 1 : 0,
      strategy.show_settings ? 1 : 0,
      strategy.show_chart ? 1 : 0,
      strategy.show_indicators ? 1 : 0,
      strategy.show_positions_on_chart ? 1 : 0,
      strategy.show_values_each_bar ? 1 : 0,
      strategy.auto_update ? 1 : 0,
      strategy.take_profit_percent,
      strategy.price_channel_length,
      strategy.detection_source,
      strategy.base_symbol,
      strategy.quote_symbol,
      strategy.interval,
      strategy.base_coef,
      strategy.quote_coef,
      strategy.long_enabled ? 1 : 0,
      strategy.short_enabled ? 1 : 0,
      strategy.lot_long_percent,
      strategy.lot_short_percent,
      strategy.max_deposit,
      strategy.margin_type,
      strategy.leverage,
      strategy.fixed_lot ? 1 : 0,
      strategy.reinvest_percent,
      strategy.state,
      strategy.entry_ratio,
      strategy.last_signal,
      strategy.last_action,
      strategy.last_error,
    ]
  );

  const created = await getStrategyRow(apiKeyName, Number(result.lastID));
  return normalizeStrategy(created);
};

export const updateStrategy = async (
  apiKeyName: string,
  strategyId: number,
  patch: Partial<Strategy>
): Promise<Strategy> => {
  const existing = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  const merged: Strategy = {
    ...existing,
    name: patch.name !== undefined ? String(patch.name) : existing.name,
    strategy_type: 'DD_BattleToads',
    is_active: patch.is_active !== undefined ? safeBoolean(patch.is_active, existing.is_active) : existing.is_active,
    display_on_chart: patch.display_on_chart !== undefined ? safeBoolean(patch.display_on_chart, existing.display_on_chart) : existing.display_on_chart,
    show_settings: patch.show_settings !== undefined ? safeBoolean(patch.show_settings, existing.show_settings) : existing.show_settings,
    show_chart: patch.show_chart !== undefined ? safeBoolean(patch.show_chart, existing.show_chart) : existing.show_chart,
    show_indicators:
      patch.show_indicators !== undefined ? safeBoolean(patch.show_indicators, existing.show_indicators) : existing.show_indicators,
    show_positions_on_chart:
      patch.show_positions_on_chart !== undefined
        ? safeBoolean(patch.show_positions_on_chart, existing.show_positions_on_chart)
        : existing.show_positions_on_chart,
    show_values_each_bar:
      patch.show_values_each_bar !== undefined
        ? safeBoolean(patch.show_values_each_bar, existing.show_values_each_bar)
        : existing.show_values_each_bar,
    auto_update: patch.auto_update !== undefined ? safeBoolean(patch.auto_update, existing.auto_update) : existing.auto_update,
    take_profit_percent:
      patch.take_profit_percent !== undefined ? safeNumber(patch.take_profit_percent, existing.take_profit_percent) : existing.take_profit_percent,
    price_channel_length:
      patch.price_channel_length !== undefined
        ? Math.max(2, Math.floor(safeNumber(patch.price_channel_length, existing.price_channel_length)))
        : existing.price_channel_length,
    detection_source: patch.detection_source === 'wick' ? 'wick' : patch.detection_source === 'close' ? 'close' : existing.detection_source,
    base_symbol: patch.base_symbol !== undefined ? normalizeSymbol(String(patch.base_symbol)) : existing.base_symbol,
    quote_symbol: patch.quote_symbol !== undefined ? normalizeSymbol(String(patch.quote_symbol)) : existing.quote_symbol,
    interval: patch.interval !== undefined ? String(patch.interval) : existing.interval,
    base_coef: patch.base_coef !== undefined ? safeNumber(patch.base_coef, existing.base_coef) : existing.base_coef,
    quote_coef: patch.quote_coef !== undefined ? safeNumber(patch.quote_coef, existing.quote_coef) : existing.quote_coef,
    long_enabled: patch.long_enabled !== undefined ? safeBoolean(patch.long_enabled, existing.long_enabled) : existing.long_enabled,
    short_enabled: patch.short_enabled !== undefined ? safeBoolean(patch.short_enabled, existing.short_enabled) : existing.short_enabled,
    lot_long_percent:
      patch.lot_long_percent !== undefined ? safeNumber(patch.lot_long_percent, existing.lot_long_percent) : existing.lot_long_percent,
    lot_short_percent:
      patch.lot_short_percent !== undefined ? safeNumber(patch.lot_short_percent, existing.lot_short_percent) : existing.lot_short_percent,
    max_deposit: patch.max_deposit !== undefined ? safeNumber(patch.max_deposit, existing.max_deposit) : existing.max_deposit,
    margin_type: patch.margin_type === 'isolated' ? 'isolated' : patch.margin_type === 'cross' ? 'cross' : existing.margin_type,
    leverage: patch.leverage !== undefined ? Math.max(1, safeNumber(patch.leverage, existing.leverage)) : existing.leverage,
    fixed_lot: patch.fixed_lot !== undefined ? safeBoolean(patch.fixed_lot, existing.fixed_lot) : existing.fixed_lot,
    reinvest_percent:
      patch.reinvest_percent !== undefined ? safeNumber(patch.reinvest_percent, existing.reinvest_percent) : existing.reinvest_percent,
    state: patch.state !== undefined ? patch.state : existing.state,
    entry_ratio: patch.entry_ratio !== undefined ? patch.entry_ratio : existing.entry_ratio,
    last_signal: patch.last_signal !== undefined ? patch.last_signal : existing.last_signal,
    last_action: patch.last_action !== undefined ? patch.last_action : existing.last_action,
    last_error: patch.last_error !== undefined ? patch.last_error : existing.last_error,
  };

  await writeStrategy(merged);
  const updated = await getStrategyRow(apiKeyName, strategyId);
  return normalizeStrategy(updated);
};

export const deleteStrategy = async (apiKeyName: string, strategyId: number): Promise<void> => {
  const { db } = await import('../utils/database');
  await db.run(
    `DELETE FROM strategies
     WHERE id = ?
       AND api_key_id = (SELECT id FROM api_keys WHERE name = ?)`,
    [strategyId, apiKeyName]
  );
};

export const executeStrategy = async (
  apiKeyName: string,
  strategyId: number,
  chartOverride?: ChartBindingOverride
) => {
  const existingRow = await getStrategyRow(apiKeyName, strategyId);
  const strategy = normalizeStrategy(existingRow);

  if (!strategy.is_active) {
    return {
      result: 'Strategy is paused',
      action: 'paused',
    };
  }

  const mergedStrategy: Strategy = {
    ...strategy,
    base_symbol: chartOverride?.base ? normalizeSymbol(chartOverride.base) : strategy.base_symbol,
    quote_symbol: chartOverride?.quote ? normalizeSymbol(chartOverride.quote) : strategy.quote_symbol,
    interval: chartOverride?.interval ? String(chartOverride.interval) : strategy.interval,
    base_coef: chartOverride?.baseCoef !== undefined ? safeNumber(chartOverride.baseCoef, strategy.base_coef) : strategy.base_coef,
    quote_coef: chartOverride?.quoteCoef !== undefined ? safeNumber(chartOverride.quoteCoef, strategy.quote_coef) : strategy.quote_coef,
  };

  const executionBindingPatch: Partial<Strategy> = {};
  if (chartOverride?.base) {
    executionBindingPatch.base_symbol = mergedStrategy.base_symbol;
  }
  if (chartOverride?.quote) {
    executionBindingPatch.quote_symbol = mergedStrategy.quote_symbol;
  }
  if (chartOverride?.interval) {
    executionBindingPatch.interval = mergedStrategy.interval;
  }
  if (chartOverride?.baseCoef !== undefined) {
    executionBindingPatch.base_coef = mergedStrategy.base_coef;
  }
  if (chartOverride?.quoteCoef !== undefined) {
    executionBindingPatch.quote_coef = mergedStrategy.quote_coef;
  }

  if (!mergedStrategy.base_symbol || !mergedStrategy.quote_symbol) {
    throw new Error('Strategy requires both base and quote symbols');
  }

  if (mergedStrategy.base_symbol === mergedStrategy.quote_symbol) {
    throw new Error('Base and quote symbols must be different');
  }

  const lookback = Math.max(mergedStrategy.price_channel_length + 30, 120);

  const syntheticRaw = await calculateSyntheticOHLC(
    apiKeyName,
    mergedStrategy.base_symbol,
    mergedStrategy.quote_symbol,
    mergedStrategy.base_coef,
    mergedStrategy.quote_coef,
    mergedStrategy.interval,
    lookback
  );

  const candles = syntheticRaw
    .map(parseSyntheticCandle)
    .filter((item): item is ParsedSyntheticCandle => !!item)
    .sort((a, b) => a.timeMs - b.timeMs);

  const { signal, currentRatio, donchianHigh, donchianLow, donchianCenter } = computeSignal(
    candles,
    mergedStrategy.price_channel_length,
    mergedStrategy.detection_source,
    mergedStrategy.long_enabled,
    mergedStrategy.short_enabled
  );

  const takeProfitFactor = 1 + Math.max(0, mergedStrategy.take_profit_percent) / 100;
  const state = mergedStrategy.state || 'flat';
  const entryRatio = mergedStrategy.entry_ratio;

  const livePositions = await getPositions(apiKeyName);
  const liveBase = livePositions.find((position: any) => {
    return String(position?.symbol || '').toUpperCase() === mergedStrategy.base_symbol.toUpperCase()
      && Number.parseFloat(String(position?.size || '0')) > 0;
  }) || null;
  const liveQuote = livePositions.find((position: any) => {
    return String(position?.symbol || '').toUpperCase() === mergedStrategy.quote_symbol.toUpperCase()
      && Number.parseFloat(String(position?.size || '0')) > 0;
  }) || null;

  const livePairState = inferSyntheticStateFromPair(liveBase, liveQuote);

  if (livePairState === 'mixed') {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: 'desync_closed_mixed',
      last_error: null,
    });

    logger.warn(`Detected mixed pair state for strategy ${strategyId}; positions were closed`);
    return {
      result: 'Mixed pair positions detected and closed',
      action: 'desync_closed_mixed',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state !== 'flat' && livePairState !== 'flat' && state !== livePairState) {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: 'desync_closed_state_mismatch',
      last_error: null,
    });

    logger.warn(`Detected wrong-side live state for strategy ${strategyId}; positions were closed`);
    return {
      result: 'Live pair state mismatched strategy state and was closed',
      action: 'desync_closed_state_mismatch',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === 'flat' && livePairState !== 'flat') {
    if (signal !== 'none' && signal !== livePairState) {
      await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
      await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

      const updated = await updateStrategy(apiKeyName, strategyId, {
        ...executionBindingPatch,
        state: 'flat',
        entry_ratio: null,
        last_action: 'desync_closed_against_signal',
        last_error: null,
      });

      logger.warn(`Closed manual/out-of-sync positions against current signal for strategy ${strategyId}`);
      return {
        result: 'Out-of-sync positions against current signal were closed',
        action: 'desync_closed_against_signal',
        strategy: updated,
        currentRatio,
        donchianHigh,
        donchianLow,
        donchianCenter,
      };
    }

    const synced = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: livePairState,
      entry_ratio: currentRatio,
      last_action: `state_resynced_${livePairState}`,
      last_error: null,
    });

    return {
      result: 'Strategy state resynced from live pair positions',
      action: `state_resynced_${livePairState}`,
      strategy: synced,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === 'long' && entryRatio && currentRatio >= entryRatio * takeProfitFactor) {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: `take_profit_long@${currentRatio}`,
      last_signal: 'long',
      last_error: null,
    });

    logger.info(`DD_BattleToads TP long triggered for strategy ${strategyId} (${apiKeyName})`);
    return {
      result: 'Take-profit hit for long synthetic position',
      action: 'take_profit_long',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === 'short' && entryRatio && currentRatio <= entryRatio / takeProfitFactor) {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: `take_profit_short@${currentRatio}`,
      last_signal: 'short',
      last_error: null,
    });

    logger.info(`DD_BattleToads TP short triggered for strategy ${strategyId} (${apiKeyName})`);
    return {
      result: 'Take-profit hit for short synthetic position',
      action: 'take_profit_short',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === 'long' && entryRatio && currentRatio <= donchianCenter) {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: `stop_loss_long@${currentRatio}`,
      last_signal: 'long',
      last_error: null,
    });

    logger.info(`DD_BattleToads SL long triggered for strategy ${strategyId} (${apiKeyName})`);
    return {
      result: 'Stop-loss (center) hit for long synthetic position',
      action: 'stop_loss_long',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === 'short' && entryRatio && currentRatio >= donchianCenter) {
    await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
    await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      state: 'flat',
      entry_ratio: null,
      last_action: `stop_loss_short@${currentRatio}`,
      last_signal: 'short',
      last_error: null,
    });

    logger.info(`DD_BattleToads SL short triggered for strategy ${strategyId} (${apiKeyName})`);
    return {
      result: 'Stop-loss (center) hit for short synthetic position',
      action: 'stop_loss_short',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (signal === 'none') {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: 'none',
      last_action: `no_signal@${currentRatio}`,
      last_error: null,
    });

    return {
      result: 'No Donchian signal',
      action: 'no_signal',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  if (state === signal) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: `hold_${signal}@${currentRatio}`,
      last_error: null,
    });

    return {
      result: `Signal ${signal} already in position`,
      action: `hold_${signal}`,
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  const balances = await getBalances(apiKeyName);
  const availableBalance = extractUsdtBalance(balances);

  if (availableBalance <= 0) {
    throw new Error('No available balance for strategy execution');
  }

  const cappedBalance = mergedStrategy.max_deposit > 0
    ? Math.min(availableBalance, mergedStrategy.max_deposit)
    : availableBalance;

  const lotPercent = signal === 'long' ? mergedStrategy.lot_long_percent : mergedStrategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestFactor = mergedStrategy.fixed_lot ? 1 : 1 + Math.max(0, mergedStrategy.reinvest_percent) / 100;

  const baseCapital = mergedStrategy.fixed_lot
    ? (mergedStrategy.max_deposit > 0 ? mergedStrategy.max_deposit : cappedBalance)
    : cappedBalance;

  const totalNotional = baseCapital * lotFraction * reinvestFactor * Math.max(1, mergedStrategy.leverage);

  if (!Number.isFinite(totalNotional) || totalNotional <= 0) {
    throw new Error('Calculated trade notional is invalid');
  }

  const basePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.base_symbol);
  const quotePrice = await getLatestMarketClose(apiKeyName, mergedStrategy.quote_symbol);

  const baseWeight = Math.abs(mergedStrategy.base_coef);
  const quoteWeight = Math.abs(mergedStrategy.quote_coef);
  const totalWeight = baseWeight + quoteWeight;

  if (!Number.isFinite(totalWeight) || totalWeight <= 0) {
    throw new Error('Synthetic coefficient weights are invalid');
  }

  const baseNotional = totalNotional * (baseWeight / totalWeight);
  const quoteNotional = totalNotional * (quoteWeight / totalWeight);

  const rawBaseQty = baseNotional / basePrice;
  const rawQuoteQty = quoteNotional / quotePrice;

  const baseQty = await normalizeQtyByStep(apiKeyName, mergedStrategy.base_symbol, rawBaseQty);
  const quoteQty = await normalizeQtyByStep(apiKeyName, mergedStrategy.quote_symbol, rawQuoteQty);

  const latestBeforeOpen = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  if (!latestBeforeOpen.is_active) {
    const updated = await updateStrategy(apiKeyName, strategyId, {
      ...executionBindingPatch,
      last_signal: signal,
      last_action: `paused_before_open@${currentRatio}`,
      last_error: null,
    });

    return {
      result: 'Strategy paused before opening a new position',
      action: 'paused_before_open',
      strategy: updated,
      currentRatio,
      donchianHigh,
      donchianLow,
      donchianCenter,
    };
  }

  try {
    await applySymbolRiskSettings(apiKeyName, mergedStrategy.base_symbol, mergedStrategy.margin_type, mergedStrategy.leverage);
    await applySymbolRiskSettings(apiKeyName, mergedStrategy.quote_symbol, mergedStrategy.margin_type, mergedStrategy.leverage);
  } catch (error) {
    logger.warn(`Could not apply risk settings for strategy ${strategyId}: ${formatActionError(error)}`);
  }

  await closeAllForSymbol(apiKeyName, mergedStrategy.base_symbol);
  await closeAllForSymbol(apiKeyName, mergedStrategy.quote_symbol);

  const baseSide: 'Buy' | 'Sell' = signal === 'long' ? 'Buy' : 'Sell';
  const quoteSide: 'Buy' | 'Sell' = signal === 'long' ? 'Sell' : 'Buy';

  const baseOrder = await placeOrder(apiKeyName, mergedStrategy.base_symbol, baseSide, baseQty);

  try {
    await placeOrder(apiKeyName, mergedStrategy.quote_symbol, quoteSide, quoteQty);
  } catch (error) {
    // Rollback the first leg if the second fails to avoid stale directional exposure.
    try {
      await closePosition(apiKeyName, mergedStrategy.base_symbol, baseQty, baseSide);
    } catch (rollbackError) {
      logger.error(`Rollback failed for ${mergedStrategy.base_symbol}: ${formatActionError(rollbackError)}`);
    }
    throw error;
  }

  const updated = await updateStrategy(apiKeyName, strategyId, {
    ...executionBindingPatch,
    state: signal,
    entry_ratio: currentRatio,
    last_signal: signal,
    last_action: `opened_${signal}@${currentRatio}`,
    last_error: null,
  });

  logger.info(`Executed DD_BattleToads strategy ${strategyId} for ${apiKeyName}: ${signal}`);
  return {
    result: 'Strategy executed',
    action: `opened_${signal}`,
    signal,
    baseOrder,
    baseQty,
    quoteQty,
    currentRatio,
    donchianHigh,
    donchianLow,
    donchianCenter,
    strategy: updated,
  };
};

export const pauseStrategy = async (apiKeyName: string, strategyId: number) => {
  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    last_action: 'paused',
  });
  logger.info(`Paused strategy ${strategyId}`);
  return updated;
};

export const stopStrategy = async (apiKeyName: string, strategyId: number) => {
  const row = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  await closeAllForSymbol(apiKeyName, row.base_symbol);
  await closeAllForSymbol(apiKeyName, row.quote_symbol);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    is_active: false,
    state: 'flat',
    entry_ratio: null,
    last_action: 'stopped',
    last_error: null,
  });

  logger.info(`Stopped strategy ${strategyId}`);
  return updated;
};

export const closePositionPercent = async (
  apiKeyName: string,
  strategyId: number,
  symbol: string,
  percent: number,
  side?: 'Buy' | 'Sell'
) => {
  const positions = await getPositions(apiKeyName, symbol);
  const target = positions.find((position: any) => {
    const sameSymbol = String(position?.symbol || '').toUpperCase() === symbol.toUpperCase();
    const hasSize = Number.parseFloat(String(position?.size || '0')) > 0;
    const sideMatches = side ? String(position?.side || '') === side : true;
    return sameSymbol && hasSize && sideMatches;
  });

  if (!target) {
    throw new Error(`Position not found for ${symbol}`);
  }

  const safePercent = Math.max(0.1, Math.min(100, Number.isFinite(percent) ? percent : 100));
  const qtyToClose = (Number.parseFloat(String(target.size || '0')) * safePercent) / 100;
  const qty = qtyToClose.toFixed(8).replace(/\.?0+$/, '');

  await closePosition(apiKeyName, symbol, qty, target.side as 'Buy' | 'Sell');
  logger.info(`Closed ${safePercent}% of position for ${symbol} (strategy ${strategyId})`);
};

export const placeManualOrder = async (
  apiKeyName: string,
  symbol: string,
  side: 'Buy' | 'Sell',
  qty: string,
  price?: string
) => {
  return await placeOrder(apiKeyName, symbol, side, qty, price);
};

export const cancelStrategyOrders = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await cancelAllOrders(apiKeyName, strategy.base_symbol);
  await cancelAllOrders(apiKeyName, strategy.quote_symbol);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    last_action: 'orders_cancelled',
    last_error: null,
  });

  logger.info(`Cancelled orders for strategy ${strategyId}`);
  return updated;
};

export const closeStrategyPositions = async (apiKeyName: string, strategyId: number) => {
  const strategy = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));

  await closeAllForSymbol(apiKeyName, strategy.base_symbol);
  await closeAllForSymbol(apiKeyName, strategy.quote_symbol);

  const updated = await updateStrategy(apiKeyName, strategyId, {
    state: 'flat',
    entry_ratio: null,
    last_action: 'positions_closed',
    last_error: null,
  });

  logger.info(`Closed pair positions for strategy ${strategyId}`);
  return updated;
};

export const setAllStrategiesActive = async (apiKeyName: string, isActive: boolean) => {
  const { db } = await import('../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);
  const result: any = await db.run(
    `UPDATE strategies
     SET is_active = ?,
         last_action = ?,
         last_error = NULL,
         updated_at = CURRENT_TIMESTAMP
     WHERE api_key_id = ?`,
    [isActive ? 1 : 0, isActive ? 'resumed_all' : 'paused_all', apiKeyId]
  );

  const updated = Number(result?.changes || 0);

  return {
    updated,
  };
};

type CopyStrategiesOptions = {
  replaceTarget?: boolean;
  preserveActive?: boolean;
  syncSymbols?: boolean;
};

type CopyChartSuggestion = {
  base: string;
  quote: string;
  interval: string;
  baseCoef: number;
  quoteCoef: number;
};

const buildTargetSymbolMap = (symbols: string[]): Map<string, string> => {
  const map = new Map<string, string>();
  for (const symbol of symbols) {
    const normalized = normalizeSymbolKey(symbol);
    if (!normalized) {
      continue;
    }
    if (!map.has(normalized)) {
      map.set(normalized, String(symbol).toUpperCase());
    }
  }
  return map;
};

const mapStrategySymbolForTarget = (symbol: string, symbolMap: Map<string, string>): string | null => {
  const normalized = normalizeSymbolKey(symbol);
  if (!normalized) {
    return null;
  }
  return symbolMap.get(normalized) || null;
};

export const copyStrategyBlock = async (
  sourceApiKeyName: string,
  targetApiKeyName: string,
  options?: CopyStrategiesOptions
) => {
  if (sourceApiKeyName === targetApiKeyName) {
    throw new Error('Source and target API key must be different');
  }

  const sourceStrategies = await getStrategies(sourceApiKeyName);
  if (sourceStrategies.length === 0) {
    return {
      copied: 0,
      deleted: 0,
    };
  }

  const replaceTarget = options?.replaceTarget !== false;
  const preserveActive = options?.preserveActive === true;
  const syncSymbols = options?.syncSymbols !== false;

  const { db } = await import('../utils/database');
  const targetApiKeyId = await getApiKeyId(targetApiKeyName);

  let targetSymbolMap = new Map<string, string>();
  let symbolValidationEnabled = false;

  if (syncSymbols) {
    try {
      const targetSymbols = await getAllSymbols(targetApiKeyName);
      targetSymbolMap = buildTargetSymbolMap(Array.isArray(targetSymbols) ? targetSymbols : []);
      symbolValidationEnabled = targetSymbolMap.size > 0;
    } catch (error) {
      logger.warn(`Symbol sync skipped for copy ${sourceApiKeyName} -> ${targetApiKeyName}: ${formatActionError(error)}`);
    }
  }

  let deleted = 0;
  let copied = 0;
  let adjustedSymbols = 0;
  let disabledStrategies = 0;
  const issues: string[] = [];
  let chartSuggestion: CopyChartSuggestion | null = null;
  let transactionStarted = false;

  try {
    await db.exec('BEGIN IMMEDIATE TRANSACTION');
    transactionStarted = true;

    if (replaceTarget) {
      const removeResult: any = await db.run('DELETE FROM strategies WHERE api_key_id = ?', [targetApiKeyId]);
      deleted = Number(removeResult?.changes || 0);
    }

    for (const source of sourceStrategies) {
      const sourceBase = normalizeSymbol(source.base_symbol);
      const sourceQuote = normalizeSymbol(source.quote_symbol);

      const mappedBase = symbolValidationEnabled
        ? mapStrategySymbolForTarget(sourceBase, targetSymbolMap)
        : sourceBase;
      const mappedQuote = symbolValidationEnabled
        ? mapStrategySymbolForTarget(sourceQuote, targetSymbolMap)
        : sourceQuote;

      const pairValid = symbolValidationEnabled
        ? Boolean(mappedBase && mappedQuote && mappedBase !== mappedQuote)
        : Boolean(sourceBase && sourceQuote && sourceBase !== sourceQuote);

      const targetBase = mappedBase || sourceBase;
      const targetQuote = mappedQuote || sourceQuote;

      if (targetBase !== sourceBase || targetQuote !== sourceQuote) {
        adjustedSymbols += 1;
      }

      const created = await createStrategy(targetApiKeyName, {
        name: source.name,
        strategy_type: 'DD_BattleToads',
        is_active: pairValid ? (preserveActive ? source.is_active : false) : false,
        display_on_chart: source.display_on_chart,
        show_settings: source.show_settings,
        show_chart: source.show_chart,
        show_indicators: source.show_indicators,
        show_positions_on_chart: source.show_positions_on_chart,
        show_values_each_bar: source.show_values_each_bar,
        auto_update: source.auto_update,
        take_profit_percent: source.take_profit_percent,
        price_channel_length: source.price_channel_length,
        detection_source: source.detection_source,
        base_symbol: targetBase,
        quote_symbol: targetQuote,
        interval: source.interval,
        base_coef: source.base_coef,
        quote_coef: source.quote_coef,
        long_enabled: source.long_enabled,
        short_enabled: source.short_enabled,
        lot_long_percent: source.lot_long_percent,
        lot_short_percent: source.lot_short_percent,
        max_deposit: source.max_deposit,
        margin_type: source.margin_type,
        leverage: source.leverage,
        fixed_lot: source.fixed_lot,
        reinvest_percent: source.reinvest_percent,
      });

      if (!pairValid) {
        disabledStrategies += 1;
        const issue = `Strategy ${source.name}: pair ${sourceBase}/${sourceQuote} is not available on ${targetApiKeyName}`;
        issues.push(issue);

        if (created.id) {
          await updateStrategy(targetApiKeyName, Number(created.id), {
            is_active: false,
            state: 'flat',
            entry_ratio: null,
            last_action: 'copied_symbol_mismatch',
            last_error: issue,
          });
        }
      } else if (!chartSuggestion) {
        chartSuggestion = {
          base: targetBase,
          quote: targetQuote,
          interval: source.interval,
          baseCoef: source.base_coef,
          quoteCoef: source.quote_coef,
        };
      }

      copied += 1;
    }

    await db.exec('COMMIT');
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      await db.exec('ROLLBACK');
    }
    throw error;
  }

  logger.info(
    `Copied strategy block from ${sourceApiKeyName} to ${targetApiKeyName}, copied=${copied}, deleted=${deleted}, adjusted=${adjustedSymbols}, disabled=${disabledStrategies}`
  );

  return {
    copied,
    deleted,
    adjustedSymbols,
    disabledStrategies,
    symbolValidationEnabled,
    issues,
    chartSuggestion,
  };
};

export const runAutoStrategiesCycle = async () => {
  const { db } = await import('../utils/database');
  const rows = await db.all(
    `SELECT a.name AS api_key_name, s.id AS strategy_id
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE s.is_active = 1 AND s.auto_update = 1
     ORDER BY s.id ASC`
  );

  const jobs = Array.isArray(rows) ? rows : [];
  let processed = 0;
  let failed = 0;

  for (const row of jobs) {
    const apiKeyName = String(row?.api_key_name || '');
    const strategyId = Number(row?.strategy_id || 0);

    if (!apiKeyName || !Number.isFinite(strategyId) || strategyId <= 0) {
      continue;
    }

    try {
      await executeStrategy(apiKeyName, strategyId);
      processed += 1;
    } catch (error) {
      failed += 1;
      logger.warn(`Auto-cycle strategy ${strategyId} (${apiKeyName}) failed: ${formatActionError(error)}`);
    }
  }

  return {
    total: jobs.length,
    processed,
    failed,
  };
};

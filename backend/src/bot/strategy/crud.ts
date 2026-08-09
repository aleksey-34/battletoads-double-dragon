/**
 * Strategy CRUD (extracted from bot/strategy.ts).
 */
import { Strategy } from '../../config/settings';
import { getBalances, getAllSymbols } from '../exchange';
import logger from '../../utils/logger';
import {
  DEFAULT_STRATEGY,
  normalizeCoef,
  normalizeInterval,
  normalizeMarketMode,
  normalizeStrategy,
  normalizeStrategyType,
  normalizeSymbol,
  normalizeSymbolKey,
  normalizeZscoreEntry,
  normalizeZscoreExit,
  normalizeZscoreStop,
  isMrs2StrategyType,
  normalizeMrs2ZscoreBand,
  normalizeMrs2ConfigJson,
  safeBoolean,
  safeNumber,
  validateStrategyBinding,
  getTypeAwareStrategyDefaults,
} from './normalize';
import type { StrategyDraft, StrategySummary, GetStrategiesOptions } from './types';

export type { StrategySummary, GetStrategiesOptions } from './types';

export const formatActionError = (error: unknown): string => {
  return error instanceof Error ? error.message : String(error);
};

export const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const { db } = await import('../../utils/database');
  const keyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!keyRow) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(keyRow.id);
};

export const getStrategyRow = async (apiKeyName: string, strategyId: number): Promise<any> => {
  const { db } = await import('../../utils/database');
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

export const extractUsdtBalance = (balances: any[]): number => {
  const list = Array.isArray(balances) ? balances : [];
  const usdt = list.find((item: any) => String(item?.coin || '').toUpperCase() === 'USDT');

  if (usdt) {
    const wallet = Number.parseFloat(String(usdt.walletBalance ?? '0'));
    const available = Number.parseFloat(String(usdt.availableBalance ?? '0'));
    // Use availableBalance (free margin) for lot sizing — walletBalance may
    // include unrealised PnL / locked margin causing orders larger than the
    // exchange will accept. Fall back to walletBalance only when available is
    // missing or zero.
    const fromUsdt = Number.isFinite(available) && available > 0 ? available
      : Number.isFinite(wallet) && wallet > 0 ? wallet
      : 0;
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

export const computeSignalTotalNotional = (
  strategy: Pick<Strategy, 'max_deposit' | 'fixed_lot' | 'reinvest_percent' | 'lot_long_percent' | 'lot_short_percent' | 'leverage'>,
  availableBalance: number,
  signal: 'long' | 'short',
  riskMultiplier = 1.0,
): number => {
  const safeAvailable = Number.isFinite(availableBalance) && availableBalance > 0 ? availableBalance : 0;
  const safeRiskMultiplier = Number.isFinite(riskMultiplier) && riskMultiplier > 0 ? riskMultiplier : 1.0;

  const cappedBalance = strategy.max_deposit > 0
    ? Math.min(safeAvailable, strategy.max_deposit)
    : safeAvailable;

  const lotPercent = signal === 'long' ? strategy.lot_long_percent : strategy.lot_short_percent;
  const lotFraction = Math.max(0, lotPercent) / 100;
  const reinvestFactor = strategy.fixed_lot ? 1 : 1 + Math.max(0, strategy.reinvest_percent) / 100;

  const baseCapital = strategy.fixed_lot
    ? (strategy.max_deposit > 0 ? strategy.max_deposit : cappedBalance)
    : cappedBalance;

  // Notional = capital × lot_fraction × risk_multiplier. Leverage is an exchange margin setting only,
  // NOT a position-size multiplier. Position weight is controlled via lot_percent/max_deposit.
  const totalNotional = baseCapital * lotFraction * reinvestFactor * safeRiskMultiplier;

  // Safety telemetry: notional must not exceed real equity unless fixed_lot is explicitly on
  // (fixed_lot is the opt-in "treat max_deposit as virtual capital" mode for risk experiments).
  // For default (fixed_lot=0) configs this should never trigger because baseCapital = min(equity, max_deposit).
  if (
    Number.isFinite(totalNotional) &&
    totalNotional > 0 &&
    safeAvailable > 0 &&
    totalNotional > safeAvailable * 1.001 &&
    !strategy.fixed_lot
  ) {
    logger.warn(
      `[sizing-guard] computed notional=${totalNotional.toFixed(2)} exceeds available equity=${safeAvailable.toFixed(2)} ` +
      `(max_deposit=${strategy.max_deposit}, lot=${(lotFraction * 100).toFixed(2)}%, reinvest=${strategy.reinvest_percent}%, fixed_lot=false). ` +
      `This indicates a sizing-formula regression — please investigate.`
    );
  }

  return Number.isFinite(totalNotional) && totalNotional > 0 ? totalNotional : 0;
};

export const getStrategies = async (apiKeyName: string, options?: GetStrategiesOptions): Promise<Strategy[]> => {
  const { db } = await import('../../utils/database');
  const limitRaw = Number(options?.limit);
  const offsetRaw = Number(options?.offset);
  const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
  const limit = hasLimit ? Math.floor(limitRaw) : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const sqlParts = [
    `SELECT s.*`,
    `FROM strategies s`,
    `JOIN api_keys a ON a.id = s.api_key_id`,
    `WHERE a.name = ?`,
  ];
  const params: any[] = [apiKeyName];

  const marketType = options?.marketType;
  if (marketType && marketType !== 'all') {
    sqlParts.push(`AND COALESCE(s.market_type, 'futures') = ?`);
    params.push(marketType);
  }

  sqlParts.push(`ORDER BY s.id DESC`);

  if (hasLimit) {
    sqlParts.push('LIMIT ? OFFSET ?');
    params.push(limit, offset);
  }

  const rows = await db.all(sqlParts.join('\n'), params);

  const normalized = rows.map(normalizeStrategy);

  const includeLotPreview = options?.includeLotPreview !== false;
  if (!includeLotPreview) {
    return normalized.map((strategy) => ({
      ...strategy,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    }));
  }

  let availableBalance: number | null = null;

  try {
    const balances = await getBalances(apiKeyName);
    availableBalance = extractUsdtBalance(balances);
  } catch (error) {
    logger.warn(`Could not compute lot preview balance for ${apiKeyName}: ${formatActionError(error)}`);
  }

  return normalized.map((strategy) => {
    if (availableBalance === null) {
      return {
        ...strategy,
        lot_long_usdt: null,
        lot_short_usdt: null,
        lot_balance_usdt: null,
      };
    }

    return {
      ...strategy,
      lot_long_usdt: computeSignalTotalNotional(strategy, availableBalance, 'long'),
      lot_short_usdt: computeSignalTotalNotional(strategy, availableBalance, 'short'),
      lot_balance_usdt: availableBalance,
    };
  });
};

export const getStrategySummaries = async (
  apiKeyName: string,
  options?: { limit?: number; offset?: number; includeArchived?: boolean; runtimeOnly?: boolean }
): Promise<StrategySummary[]> => {
  const { db } = await import('../../utils/database');
  const limitRaw = Number(options?.limit);
  const offsetRaw = Number(options?.offset);
  const hasLimit = Number.isFinite(limitRaw) && limitRaw > 0;
  const limit = hasLimit ? Math.floor(limitRaw) : 0;
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;

  const sqlParts = [
    `SELECT s.id, s.name, s.strategy_type, s.market_mode, s.is_active, s.base_symbol, s.quote_symbol, s.interval, s.base_coef, s.quote_coef, s.state, s.last_action, s.last_error, s.updated_at,
     COALESCE(s.is_runtime, 0) AS is_runtime, COALESCE(s.is_archived, 0) AS is_archived, COALESCE(s.origin, 'manual') AS origin`,
    `FROM strategies s`,
    `JOIN api_keys a ON a.id = s.api_key_id`,
    `WHERE a.name = ?`,
  ];
  const params: any[] = [apiKeyName];

  if (!options?.includeArchived) {
    sqlParts.push(`AND COALESCE(s.is_archived, 0) = 0`);
  }

  if (options?.runtimeOnly) {
    sqlParts.push(`AND COALESCE(s.is_runtime, 0) = 1`);
  }

  sqlParts.push(`ORDER BY s.is_active DESC, s.id DESC`);

  if (hasLimit) {
    sqlParts.push('LIMIT ? OFFSET ?');
    params.push(limit, offset);
  }

  const rows = await db.all(sqlParts.join('\n'), params);

  return rows.map((row: any) => {
    const marketMode = normalizeMarketMode(row.market_mode);
    return {
      id: Number(row.id),
      name: String(row.name || DEFAULT_STRATEGY.name),
      strategy_type: normalizeStrategyType(row.strategy_type),
      market_mode: marketMode,
      is_active: safeBoolean(row.is_active, true),
      base_symbol: normalizeSymbol(String(row.base_symbol || DEFAULT_STRATEGY.base_symbol)),
      quote_symbol: marketMode === 'mono'
        ? normalizeSymbol(String(row.quote_symbol || ''))
        : normalizeSymbol(String(row.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
      interval: String(row.interval || DEFAULT_STRATEGY.interval),
      base_coef: safeNumber(row.base_coef, DEFAULT_STRATEGY.base_coef),
      quote_coef: marketMode === 'mono' ? safeNumber(row.quote_coef, 0) : safeNumber(row.quote_coef, DEFAULT_STRATEGY.quote_coef),
      state: String(row.state || 'flat') === 'long' ? 'long' : String(row.state || 'flat') === 'short' ? 'short' : 'flat',
      last_action: row.last_action === undefined ? null : row.last_action,
      last_error: row.last_error === undefined ? null : row.last_error,
      updated_at: row.updated_at === undefined ? null : row.updated_at,
      is_runtime: safeBoolean(row.is_runtime, false),
      is_archived: safeBoolean(row.is_archived, false),
      origin: String(row.origin || 'manual'),
    };
  });
};

export const getStrategyById = async (
  apiKeyName: string,
  strategyId: number,
  options?: { includeLotPreview?: boolean }
): Promise<Strategy> => {
  const row = await getStrategyRow(apiKeyName, strategyId);
  const normalized = normalizeStrategy(row);
  const includeLotPreview = options?.includeLotPreview !== false;

  if (!includeLotPreview) {
    return {
      ...normalized,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    };
  }

  try {
    const balances = await getBalances(apiKeyName);
    const availableBalance = extractUsdtBalance(balances);

    return {
      ...normalized,
      lot_long_usdt: computeSignalTotalNotional(normalized, availableBalance, 'long'),
      lot_short_usdt: computeSignalTotalNotional(normalized, availableBalance, 'short'),
      lot_balance_usdt: availableBalance,
    };
  } catch (error) {
    logger.warn(`Could not compute lot preview for strategy ${strategyId} (${apiKeyName}): ${formatActionError(error)}`);
    return {
      ...normalized,
      lot_long_usdt: null,
      lot_short_usdt: null,
      lot_balance_usdt: null,
    };
  }
};

export const createStrategy = async (
  apiKeyName: string,
  draft: StrategyDraft,
  options?: { allowActivePairConflict?: boolean }
): Promise<Strategy> => {
  const { db } = await import('../../utils/database');
  const apiKeyId = await getApiKeyId(apiKeyName);

  if (!options?.allowActivePairConflict) {
    // Legacy protection for manual flows. SaaS materialization can allow multiple active strategies per pair.
    const baseNorm = normalizeSymbol(String(draft.base_symbol || DEFAULT_STRATEGY.base_symbol));
    const modeNorm = normalizeMarketMode(draft.market_mode || DEFAULT_STRATEGY.market_mode);
    const quoteNorm = modeNorm === 'mono'
      ? normalizeSymbol(String(draft.quote_symbol || ''))
      : normalizeSymbol(String(draft.quote_symbol || DEFAULT_STRATEGY.quote_symbol));

    const conflict = await db.get(
      `SELECT id, name FROM strategies
       WHERE api_key_id = ? AND base_symbol = ? AND quote_symbol = ? AND is_active = 1`,
      [apiKeyId, baseNorm, quoteNorm]
    );
    if (conflict) {
      throw new Error(
        `Pair ${baseNorm}/${quoteNorm} already has an active strategy "${(conflict as any).name}" (id=${(conflict as any).id}) on this API key. ` +
        `Deactivate or delete it first, or use a different API key.`
      );
    }
  }

  const strategyType = normalizeStrategyType(draft.strategy_type || DEFAULT_STRATEGY.strategy_type);
  const marketMode = normalizeMarketMode(draft.market_mode || DEFAULT_STRATEGY.market_mode);
  const typeDefaults = getTypeAwareStrategyDefaults(strategyType);
  const mrs2Type = isMrs2StrategyType(strategyType);
  const mrs2Defaults = mrs2Type ? { zscore_entry: 0.95, zscore_exit: 1.05, zscore_stop: 0.3 } : null;
  const zscoreEntry = normalizeZscoreEntry(
    draft.zscore_entry,
    mrs2Defaults?.zscore_entry ?? DEFAULT_STRATEGY.zscore_entry,
  );
  const zscoreExit = mrs2Type
    ? normalizeMrs2ZscoreBand(draft.zscore_exit, mrs2Defaults!.zscore_exit)
    : normalizeZscoreExit(draft.zscore_exit, DEFAULT_STRATEGY.zscore_exit, zscoreEntry);
  const zscoreStop = mrs2Type
    ? normalizeMrs2ZscoreBand(draft.zscore_stop, mrs2Defaults!.zscore_stop)
    : normalizeZscoreStop(draft.zscore_stop, DEFAULT_STRATEGY.zscore_stop, zscoreEntry);
  const mrs2ConfigJson = normalizeMrs2ConfigJson((draft as any).mrs2_config_json);
  const baseSymbol = normalizeSymbol(String(draft.base_symbol || DEFAULT_STRATEGY.base_symbol));
  const quoteSymbol = marketMode === 'mono'
    ? normalizeSymbol(String(draft.quote_symbol || ''))
    : normalizeSymbol(String(draft.quote_symbol || DEFAULT_STRATEGY.quote_symbol));
  const baseCoef = safeNumber(draft.base_coef, DEFAULT_STRATEGY.base_coef);
  const quoteCoef = marketMode === 'mono' ? 0 : safeNumber(draft.quote_coef, DEFAULT_STRATEGY.quote_coef);

  const strategy: Strategy = {
    ...DEFAULT_STRATEGY,
    name: String(draft.name || DEFAULT_STRATEGY.name),
    api_key_id: apiKeyId,
    strategy_type: strategyType,
    market_mode: marketMode,
    is_active: safeBoolean(draft.is_active, DEFAULT_STRATEGY.is_active),
    display_on_chart: safeBoolean(draft.display_on_chart, DEFAULT_STRATEGY.display_on_chart),
    show_settings: safeBoolean(draft.show_settings, DEFAULT_STRATEGY.show_settings),
    show_chart: safeBoolean(draft.show_chart, DEFAULT_STRATEGY.show_chart),
    show_indicators: safeBoolean(draft.show_indicators, DEFAULT_STRATEGY.show_indicators),
    show_positions_on_chart: safeBoolean(draft.show_positions_on_chart, DEFAULT_STRATEGY.show_positions_on_chart),
    show_trades_on_chart: safeBoolean(draft.show_trades_on_chart, DEFAULT_STRATEGY.show_trades_on_chart || false),
    show_values_each_bar: safeBoolean(draft.show_values_each_bar, DEFAULT_STRATEGY.show_values_each_bar),
    auto_update: safeBoolean(draft.auto_update, DEFAULT_STRATEGY.auto_update),
    take_profit_percent: safeNumber(draft.take_profit_percent, typeDefaults.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(draft.price_channel_length, typeDefaults.price_channel_length))),
    detection_source: draft.detection_source === 'wick' ? 'wick' : typeDefaults.detection_source,
    zscore_entry: zscoreEntry,
    zscore_exit: zscoreExit,
    zscore_stop: zscoreStop,
    mrs2_config_json: mrs2ConfigJson,
    base_symbol: baseSymbol,
    quote_symbol: quoteSymbol,
    interval: String(draft.interval || DEFAULT_STRATEGY.interval).trim() || DEFAULT_STRATEGY.interval,
    base_coef: baseCoef,
    quote_coef: quoteCoef,
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
    tp_anchor_ratio: null,
    last_signal: null,
    last_action: null,
    last_error: null,
  };

  validateStrategyBinding(strategy);

  const result: any = await db.run(
    `INSERT INTO strategies (
      name,
      api_key_id,
      strategy_type,
      market_mode,
      is_active,
      display_on_chart,
      show_settings,
      show_chart,
      show_indicators,
      show_positions_on_chart,
      show_trades_on_chart,
      show_values_each_bar,
      auto_update,
      take_profit_percent,
      price_channel_length,
      detection_source,
      zscore_entry,
      zscore_exit,
      zscore_stop,
      mrs2_config_json,
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
      tp_anchor_ratio,
      last_signal,
      last_action,
      last_error,
      created_at,
      updated_at
    ) VALUES (
      ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
      CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    )`,
    [
      strategy.name,
      strategy.api_key_id,
      strategy.strategy_type,
      strategy.market_mode,
      strategy.is_active ? 1 : 0,
      strategy.display_on_chart ? 1 : 0,
      strategy.show_settings ? 1 : 0,
      strategy.show_chart ? 1 : 0,
      strategy.show_indicators ? 1 : 0,
      strategy.show_positions_on_chart ? 1 : 0,
      strategy.show_trades_on_chart ? 1 : 0,
      strategy.show_values_each_bar ? 1 : 0,
      strategy.auto_update ? 1 : 0,
      strategy.take_profit_percent,
      strategy.price_channel_length,
      strategy.detection_source,
      strategy.zscore_entry,
      strategy.zscore_exit,
      strategy.zscore_stop,
      strategy.mrs2_config_json || '{}',
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
      strategy.tp_anchor_ratio,
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
  patch: Partial<Strategy>,
  options?: {
    allowBindingUpdate?: boolean;
    source?: string;
  }
): Promise<Strategy> => {
  const existing = normalizeStrategy(await getStrategyRow(apiKeyName, strategyId));
  const updateSource = String(options?.source || 'unspecified');

  const updates: Array<{ column: string; value: any }> = [];
  const pushUpdate = (column: string, value: any) => {
    updates.push({ column, value });
  };

  const requestedMarketMode = patch.market_mode !== undefined ? normalizeMarketMode(patch.market_mode) : existing.market_mode;

  if (patch.name !== undefined) {
    pushUpdate('name', String(patch.name || '').trim() || existing.name);
  }
  if (patch.is_active !== undefined) {
    pushUpdate('is_active', safeBoolean(patch.is_active, existing.is_active) ? 1 : 0);
  }
  if (patch.display_on_chart !== undefined) {
    pushUpdate('display_on_chart', safeBoolean(patch.display_on_chart, existing.display_on_chart) ? 1 : 0);
  }
  if (patch.show_settings !== undefined) {
    pushUpdate('show_settings', safeBoolean(patch.show_settings, existing.show_settings) ? 1 : 0);
  }
  if (patch.show_chart !== undefined) {
    pushUpdate('show_chart', safeBoolean(patch.show_chart, existing.show_chart) ? 1 : 0);
  }
  if (patch.show_indicators !== undefined) {
    pushUpdate('show_indicators', safeBoolean(patch.show_indicators, existing.show_indicators) ? 1 : 0);
  }
  if (patch.show_positions_on_chart !== undefined) {
    pushUpdate(
      'show_positions_on_chart',
      safeBoolean(patch.show_positions_on_chart, existing.show_positions_on_chart) ? 1 : 0
    );
  }
  if (patch.show_trades_on_chart !== undefined) {
    pushUpdate(
      'show_trades_on_chart',
      safeBoolean(patch.show_trades_on_chart, existing.show_trades_on_chart || false) ? 1 : 0
    );
  }
  if (patch.show_values_each_bar !== undefined) {
    pushUpdate('show_values_each_bar', safeBoolean(patch.show_values_each_bar, existing.show_values_each_bar) ? 1 : 0);
  }
  if (patch.auto_update !== undefined) {
    pushUpdate('auto_update', safeBoolean(patch.auto_update, existing.auto_update) ? 1 : 0);
  }
  if (patch.take_profit_percent !== undefined) {
    pushUpdate('take_profit_percent', safeNumber(patch.take_profit_percent, existing.take_profit_percent));
  }
  if (patch.strategy_type !== undefined) {
    pushUpdate('strategy_type', normalizeStrategyType(patch.strategy_type));
  }
  if (patch.market_mode !== undefined) {
    pushUpdate('market_mode', requestedMarketMode);
    if (requestedMarketMode === 'mono') {
      pushUpdate('quote_symbol', normalizeSymbol(String(patch.quote_symbol || '')));
      pushUpdate('quote_coef', 0);
    }
  }
  if (patch.price_channel_length !== undefined) {
    pushUpdate(
      'price_channel_length',
      Math.max(2, Math.floor(safeNumber(patch.price_channel_length, existing.price_channel_length)))
    );
  }
  if (patch.detection_source !== undefined) {
    const nextDetection = patch.detection_source === 'wick' ? 'wick' : patch.detection_source === 'close' ? 'close' : existing.detection_source;
    pushUpdate('detection_source', nextDetection);
  }
  if (patch.zscore_entry !== undefined) {
    const nextType = patch.strategy_type !== undefined
      ? normalizeStrategyType(patch.strategy_type)
      : existing.strategy_type;
    const mrs2Type = isMrs2StrategyType(nextType);
    const nextEntry = normalizeZscoreEntry(patch.zscore_entry, existing.zscore_entry);
    const exitSource = patch.zscore_exit !== undefined ? patch.zscore_exit : existing.zscore_exit;
    const stopSource = patch.zscore_stop !== undefined ? patch.zscore_stop : existing.zscore_stop;
    pushUpdate('zscore_entry', nextEntry);
    pushUpdate(
      'zscore_exit',
      mrs2Type
        ? normalizeMrs2ZscoreBand(exitSource, existing.zscore_exit)
        : normalizeZscoreExit(exitSource, existing.zscore_exit, nextEntry),
    );
    pushUpdate(
      'zscore_stop',
      mrs2Type
        ? normalizeMrs2ZscoreBand(stopSource, existing.zscore_stop)
        : normalizeZscoreStop(stopSource, existing.zscore_stop, nextEntry),
    );
  } else {
    const mrs2Type = isMrs2StrategyType(
      patch.strategy_type !== undefined ? normalizeStrategyType(patch.strategy_type) : existing.strategy_type,
    );
    if (patch.zscore_exit !== undefined) {
      pushUpdate(
        'zscore_exit',
        mrs2Type
          ? normalizeMrs2ZscoreBand(patch.zscore_exit, existing.zscore_exit)
          : normalizeZscoreExit(patch.zscore_exit, existing.zscore_exit, existing.zscore_entry),
      );
    }
    if (patch.zscore_stop !== undefined) {
      pushUpdate(
        'zscore_stop',
        mrs2Type
          ? normalizeMrs2ZscoreBand(patch.zscore_stop, existing.zscore_stop)
          : normalizeZscoreStop(patch.zscore_stop, existing.zscore_stop, existing.zscore_entry),
      );
    }
  }
  if ((patch as any).mrs2_config_json !== undefined) {
    pushUpdate('mrs2_config_json', normalizeMrs2ConfigJson((patch as any).mrs2_config_json));
  }
  if (patch.base_symbol !== undefined) {
    pushUpdate('base_symbol', normalizeSymbol(String(patch.base_symbol)));
  }
  if (patch.quote_symbol !== undefined) {
    pushUpdate('quote_symbol', requestedMarketMode === 'mono' ? normalizeSymbol(String(patch.quote_symbol || '')) : normalizeSymbol(String(patch.quote_symbol)));
  }
  if (patch.interval !== undefined) {
    pushUpdate('interval', String(patch.interval || '').trim() || existing.interval);
  }
  if (patch.base_coef !== undefined) {
    pushUpdate('base_coef', safeNumber(patch.base_coef, existing.base_coef));
  }
  if (patch.quote_coef !== undefined) {
    pushUpdate('quote_coef', requestedMarketMode === 'mono' ? 0 : safeNumber(patch.quote_coef, existing.quote_coef));
  }
  if (patch.long_enabled !== undefined) {
    pushUpdate('long_enabled', safeBoolean(patch.long_enabled, existing.long_enabled) ? 1 : 0);
  }
  if (patch.short_enabled !== undefined) {
    pushUpdate('short_enabled', safeBoolean(patch.short_enabled, existing.short_enabled) ? 1 : 0);
  }
  if (patch.lot_long_percent !== undefined) {
    pushUpdate('lot_long_percent', safeNumber(patch.lot_long_percent, existing.lot_long_percent));
  }
  if (patch.lot_short_percent !== undefined) {
    pushUpdate('lot_short_percent', safeNumber(patch.lot_short_percent, existing.lot_short_percent));
  }
  if (patch.max_deposit !== undefined) {
    pushUpdate('max_deposit', safeNumber(patch.max_deposit, existing.max_deposit));
  }
  if (patch.margin_type !== undefined) {
    const nextMarginType = patch.margin_type === 'isolated' ? 'isolated' : patch.margin_type === 'cross' ? 'cross' : existing.margin_type;
    pushUpdate('margin_type', nextMarginType);
  }
  if (patch.leverage !== undefined) {
    pushUpdate('leverage', Math.max(1, safeNumber(patch.leverage, existing.leverage)));
  }
  if (patch.fixed_lot !== undefined) {
    pushUpdate('fixed_lot', safeBoolean(patch.fixed_lot, existing.fixed_lot) ? 1 : 0);
  }
  if (patch.reinvest_percent !== undefined) {
    pushUpdate('reinvest_percent', safeNumber(patch.reinvest_percent, existing.reinvest_percent));
  }
  if (patch.state !== undefined) {
    const nextState = patch.state === 'long' || patch.state === 'short' || patch.state === 'flat' ? patch.state : existing.state;
    pushUpdate('state', nextState);
  }
  if (patch.entry_ratio !== undefined) {
    if (patch.entry_ratio === null) {
      pushUpdate('entry_ratio', null);
    } else {
      const currentEntry = existing.entry_ratio === null || existing.entry_ratio === undefined ? 0 : existing.entry_ratio;
      pushUpdate('entry_ratio', safeNumber(patch.entry_ratio, currentEntry));
    }
  }
  if (patch.tp_anchor_ratio !== undefined) {
    if (patch.tp_anchor_ratio === null) {
      pushUpdate('tp_anchor_ratio', null);
    } else {
      const currentAnchor = existing.tp_anchor_ratio === null || existing.tp_anchor_ratio === undefined ? 0 : existing.tp_anchor_ratio;
      pushUpdate('tp_anchor_ratio', safeNumber(patch.tp_anchor_ratio, currentAnchor));
    }
  }
  if (patch.mrs2_pending_json !== undefined) {
    pushUpdate('mrs2_pending_json', patch.mrs2_pending_json == null ? '{}' : String(patch.mrs2_pending_json));
  }
  if (patch.last_signal !== undefined) {
    pushUpdate('last_signal', patch.last_signal ?? null);
  }
  if (patch.last_action !== undefined) {
    pushUpdate('last_action', patch.last_action ?? null);
  }
  if (patch.last_error !== undefined) {
    pushUpdate('last_error', patch.last_error ?? null);
  }

  const bindingTouched = (
    patch.market_mode !== undefined
    || patch.base_symbol !== undefined
    || patch.quote_symbol !== undefined
    || patch.interval !== undefined
    || patch.base_coef !== undefined
    || patch.quote_coef !== undefined
  );

  if (bindingTouched && options?.allowBindingUpdate !== true) {
    throw new Error(
      `Binding update denied for strategyId=${strategyId}, apiKey=${apiKeyName}, source=${updateSource}`
    );
  }

  if (bindingTouched) {
    validateStrategyBinding({
      market_mode: requestedMarketMode,
      base_symbol: patch.base_symbol !== undefined ? normalizeSymbol(String(patch.base_symbol)) : existing.base_symbol,
      quote_symbol: patch.quote_symbol !== undefined
        ? (requestedMarketMode === 'mono' ? normalizeSymbol(String(patch.quote_symbol || '')) : normalizeSymbol(String(patch.quote_symbol)))
        : existing.quote_symbol,
      interval: patch.interval !== undefined ? String(patch.interval || '').trim() || existing.interval : existing.interval,
      base_coef: patch.base_coef !== undefined ? safeNumber(patch.base_coef, existing.base_coef) : existing.base_coef,
      quote_coef: patch.quote_coef !== undefined
        ? (requestedMarketMode === 'mono' ? 0 : safeNumber(patch.quote_coef, existing.quote_coef))
        : existing.quote_coef,
    });
  }

  if (updates.length === 0) {
    return existing;
  }

  const { db } = await import('../../utils/database');
  const setClause = updates.map((item) => `${item.column} = ?`).join(', ');
  const params = updates.map((item) => item.value);

  if (!bindingTouched) {
    const updateResult: any = await db.run(
      `UPDATE strategies SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND api_key_id = ?`,
      [...params, strategyId, existing.api_key_id]
    );

    if (Number(updateResult?.changes || 0) !== 1) {
      throw new Error(`Strategy update failed or affected unexpected rows: strategyId=${strategyId}`);
    }
  } else {
    let transactionStarted = false;

    try {
      await db.exec('BEGIN IMMEDIATE');
      transactionStarted = true;

      const beforeRows = await db.all(
        `SELECT id, base_symbol, quote_symbol, interval, base_coef, quote_coef
         FROM strategies
         WHERE api_key_id = ?`,
        [existing.api_key_id]
      );

      const beforeById = new Map<number, any>();
      (Array.isArray(beforeRows) ? beforeRows : []).forEach((row: any) => {
        beforeById.set(Number(row.id), row);
      });

      const updateResult: any = await db.run(
        `UPDATE strategies SET ${setClause}, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND api_key_id = ?`,
        [...params, strategyId, existing.api_key_id]
      );

      if (Number(updateResult?.changes || 0) !== 1) {
        throw new Error(`Strategy update failed or affected unexpected rows: strategyId=${strategyId}`);
      }

      const afterRows = await db.all(
        `SELECT id, base_symbol, quote_symbol, interval, base_coef, quote_coef
         FROM strategies
         WHERE api_key_id = ?`,
        [existing.api_key_id]
      );

      const offenders: number[] = [];

      (Array.isArray(afterRows) ? afterRows : []).forEach((afterRow: any) => {
        const rowId = Number(afterRow.id);
        if (rowId === strategyId) {
          return;
        }

        const beforeRow = beforeById.get(rowId);
        if (!beforeRow) {
          return;
        }

        const bindingChanged = (
          normalizeSymbol(beforeRow.base_symbol) !== normalizeSymbol(afterRow.base_symbol)
          || normalizeSymbol(beforeRow.quote_symbol) !== normalizeSymbol(afterRow.quote_symbol)
          || normalizeInterval(beforeRow.interval) !== normalizeInterval(afterRow.interval)
          || Math.abs(normalizeCoef(beforeRow.base_coef) - normalizeCoef(afterRow.base_coef)) > 1e-12
          || Math.abs(normalizeCoef(beforeRow.quote_coef) - normalizeCoef(afterRow.quote_coef)) > 1e-12
        );

        if (bindingChanged) {
          offenders.push(rowId);
        }
      });

      if (offenders.length > 0) {
        logger.error(
          `Unsafe binding update blocked: strategyId=${strategyId}, apiKey=${apiKeyName}, source=${updateSource}, offenders=${offenders.join(',')}`
        );
        throw new Error(
          `Unsafe update blocked: binding fields changed for other strategies in api_key_id=${existing.api_key_id} (ids: ${offenders.join(', ')})`
        );
      }

      await db.exec('COMMIT');
      transactionStarted = false;
    } catch (error) {
      if (transactionStarted) {
        await db.exec('ROLLBACK').catch(() => {});
      }
      throw error;
    }
  }

  const updated = await getStrategyRow(apiKeyName, strategyId);
  const normalizedUpdated = normalizeStrategy(updated);

  if (bindingTouched) {
    logger.info(
      `Strategy binding updated: source=${updateSource}, apiKey=${apiKeyName}, strategyId=${strategyId}, `
      + `${existing.base_symbol}/${existing.quote_symbol}@${existing.interval} -> `
      + `${normalizedUpdated.base_symbol}/${normalizedUpdated.quote_symbol}@${normalizedUpdated.interval}`
    );
  }

  return normalizedUpdated;
};

export const deleteStrategy = async (apiKeyName: string, strategyId: number): Promise<void> => {
  const { db } = await import('../../utils/database');
  await db.run(
    `DELETE FROM strategies
     WHERE id = ?
       AND api_key_id = (SELECT id FROM api_keys WHERE name = ?)`,
    [strategyId, apiKeyName]
  );
};

export type CopyStrategiesOptions = {
  replaceTarget?: boolean;
  preserveActive?: boolean;
  syncSymbols?: boolean;
  sourceStrategyIds?: number[];
  /**
   * If true, runtime strategies on the target key whose origin is
   * 'saas_overlay_legacy' are NOT deleted during replaceTarget. They keep
   * managing their already-open positions until they go flat.
   */
  preserveLegacyOverlay?: boolean;
};

export type CopyChartSuggestion = {
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

  let sourceStrategies = await getStrategies(sourceApiKeyName);
  if (options?.sourceStrategyIds && options.sourceStrategyIds.length > 0) {
    const allowedIds = new Set(options.sourceStrategyIds);
    sourceStrategies = sourceStrategies.filter((s: any) => allowedIds.has(Number(s.id)));
  }
  if (sourceStrategies.length === 0) {
    return {
      copied: 0,
      deleted: 0,
    };
  }

  const replaceTarget = options?.replaceTarget !== false;
  const preserveActive = options?.preserveActive === true;
  const syncSymbols = options?.syncSymbols !== false;

  const { db } = await import('../../utils/database');
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

  if (replaceTarget) {
    const preserveLegacyOverlay = options?.preserveLegacyOverlay === true;
    const removeResult: any = preserveLegacyOverlay
      ? await db.run(
          `DELETE FROM strategies
             WHERE api_key_id = ?
               AND COALESCE(origin, '') <> 'saas_overlay_legacy'`,
          [targetApiKeyId]
        )
      : await db.run('DELETE FROM strategies WHERE api_key_id = ?', [targetApiKeyId]);
    deleted = Number(removeResult?.changes || 0);
  }

  for (const source of sourceStrategies) {
    const sourceBase = normalizeSymbol(source.base_symbol);
    const sourceQuote = normalizeSymbol(source.quote_symbol);
    const sourceMarketMode = normalizeMarketMode(source.market_mode);

    const mappedBase = symbolValidationEnabled
      ? mapStrategySymbolForTarget(sourceBase, targetSymbolMap)
      : sourceBase;
    const mappedQuote = symbolValidationEnabled
      ? mapStrategySymbolForTarget(sourceQuote, targetSymbolMap)
      : sourceQuote;

    const pairValid = sourceMarketMode === 'mono'
      ? (symbolValidationEnabled ? Boolean(mappedBase) : Boolean(sourceBase))
      : (symbolValidationEnabled
        ? Boolean(mappedBase && mappedQuote && mappedBase !== mappedQuote)
        : Boolean(sourceBase && sourceQuote && sourceBase !== sourceQuote));

    const targetBase = mappedBase || sourceBase;
    const targetQuote = sourceMarketMode === 'mono' ? '' : (mappedQuote || sourceQuote);

    if (targetBase !== sourceBase || targetQuote !== sourceQuote) {
      adjustedSymbols += 1;
    }

    const created = await createStrategy(targetApiKeyName, {
      name: source.name,
      strategy_type: source.strategy_type || 'DD_BattleToads',
      market_mode: source.market_mode,
      is_active: pairValid ? (preserveActive ? source.is_active : false) : false,
      display_on_chart: source.display_on_chart,
      show_settings: source.show_settings,
      show_chart: source.show_chart,
      show_indicators: source.show_indicators,
      show_positions_on_chart: source.show_positions_on_chart,
      show_trades_on_chart: source.show_trades_on_chart,
      show_values_each_bar: source.show_values_each_bar,
      auto_update: source.auto_update,
      take_profit_percent: source.take_profit_percent,
      price_channel_length: source.price_channel_length,
      detection_source: source.detection_source,
      zscore_entry: source.zscore_entry,
      zscore_exit: source.zscore_exit,
      zscore_stop: source.zscore_stop,
      mrs2_config_json: (source as any).mrs2_config_json || '{}',
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
          tp_anchor_ratio: null,
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
        quoteCoef: sourceMarketMode === 'mono' ? 0 : source.quote_coef,
      };
    }

    copied += 1;
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

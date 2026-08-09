/**
 * Strategy normalization helpers (extracted from bot/strategy.ts).
 */
import { MarketMode, Strategy, StrategyType } from '../../config/settings';

export const normalizeStrategyType = (value: any): StrategyType => {
  const normalized = String(value || '').trim();
  const lower = normalized.toLowerCase();
  if (
    normalized === 'MeanReversion'
    || normalized === 'MRS2'
    || lower === 'mrs2'
    || lower === 'mrs2_ma_limit'
    || lower === 'meanreversion'
    || lower === 'mean_reversion'
  ) {
    return 'MeanReversion';
  }
  if (normalized === 'stat_arb_zscore' || normalized === 'zz_breakout' || normalized === 'periodic_buy' || normalized === 'dca' || normalized === 'hideep' || normalized === 'CT_Fractal' || normalized === 'momentum_scalp_tv') {
    return normalized as StrategyType;
  }
  if (lower === 'zigzag' || lower === 'zig_zag') {
    return 'zz_breakout';
  }
  if (normalized === 'ZZ_Fast' || normalized === 'ZZ_Instance' || lower === 'zigzag_fast' || lower === 'zigzag_instance') {
    if (lower === 'zigzag_fast') return 'ZZ_Fast';
    if (lower === 'zigzag_instance') return 'ZZ_Instance';
    return normalized as StrategyType;
  }
  if (normalized === 'ZZ_HAMSTER_ZZ6' || normalized === 'zz_hamster_zz6') {
    return 'ZZ_Fast';
  }
  if (normalized === 'ZZ_HAMSTER_ZZ2' || normalized === 'zz_hamster_zz2') {
    return 'ZZ_Instance';
  }
  return 'DD_BattleToads';
};

export const normalizeMarketMode = (value: any): MarketMode => {
  return String(value || '').trim() === 'mono' ? 'mono' : 'synthetic';
};

export const normalizeZscoreEntry = (value: any, fallback: number): number => {
  return Math.max(0.1, safeNumber(value, fallback));
};

export const normalizeZscoreExit = (value: any, fallback: number, entry: number): number => {
  const raw = Math.max(0, safeNumber(value, fallback));
  return Math.min(raw, Math.max(0, entry - 0.05));
};

export const normalizeZscoreStop = (value: any, fallback: number, entry: number): number => {
  return Math.max(entry + 0.05, safeNumber(value, fallback));
};

/** MeanReversion/MRS2 remap zscore_* to MA mults / distance — never DD-clamp exit<entry / stop>entry. */
export const isMrs2StrategyType = (strategyType: any): boolean => {
  const t = String(strategyType || '');
  return t === 'MeanReversion' || t === 'MRS2';
};

export const normalizeMrs2ZscoreBand = (value: any, fallback: number): number => {
  return Math.max(0, safeNumber(value, fallback));
};

export const normalizeMrs2ConfigJson = (raw: any): string => {
  if (raw == null) return '{}';
  if (typeof raw === 'string') return raw.trim() || '{}';
  try {
    return JSON.stringify(raw);
  } catch {
    return '{}';
  }
};

export const DEFAULT_STRATEGY: Omit<Strategy, 'api_key_id' | 'id'> = {
  name: 'DD_BattleToads',
  strategy_type: 'DD_BattleToads',
  market_mode: 'synthetic',
  is_active: true,
  display_on_chart: true,
  show_settings: true,
  show_chart: true,
  show_indicators: true,
  show_positions_on_chart: true,
  show_trades_on_chart: false,
  show_values_each_bar: false,
  auto_update: true,
  take_profit_percent: 7.5,
  price_channel_length: 50,
  detection_source: 'close',
  zscore_entry: 2.0,
  zscore_exit: 0.5,
  zscore_stop: 3.5,
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
  tp_anchor_ratio: null,
  last_signal: null,
  last_action: null,
  partial_tp_pct: 0,
  last_error: null,
};

export const getTypeAwareStrategyDefaults = (strategyType: StrategyType) => {
  if (strategyType === 'stat_arb_zscore' || strategyType === 'CT_Fractal') {
    return {
      take_profit_percent: 0,
      price_channel_length: 120,
      detection_source: 'close' as const,
    };
  }

  if (strategyType === 'momentum_scalp_tv') {
    return {
      take_profit_percent: 2,
      price_channel_length: 8,
      detection_source: 'close' as const,
      zscore_entry: 21,
      zscore_exit: 20,
      zscore_stop: 1.2,
    };
  }

  if (strategyType === 'MeanReversion' || strategyType === 'MRS2') {
    return {
      take_profit_percent: 0,
      price_channel_length: 5,
      detection_source: 'wick' as const,
      zscore_entry: 0.95,
      zscore_exit: 1.05,
      zscore_stop: 0.3,
    };
  }

  return {
    take_profit_percent: DEFAULT_STRATEGY.take_profit_percent,
    price_channel_length: DEFAULT_STRATEGY.price_channel_length,
    detection_source: DEFAULT_STRATEGY.detection_source,
  };
};

export const safeBoolean = (value: any, fallback: boolean): boolean => {
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

export const safeNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

export const normalizeSymbol = (value: string): string => String(value || '').trim().toUpperCase();

export const normalizeInterval = (value: any): string => String(value || '').trim();

export const normalizeCoef = (value: any): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : 0;
};

export const intervalToMs = (interval: string): number => {
  const value = String(interval || '').trim();

  if (value.endsWith('m')) {
    const minutes = Number.parseInt(value.replace('m', ''), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  }

  if (value.endsWith('h')) {
    const hours = Number.parseInt(value.replace('h', ''), 10);
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  if (value === '1d') {
    return 24 * 60 * 60 * 1000;
  }

  if (value === '1w') {
    return 7 * 24 * 60 * 60 * 1000;
  }

  if (value === '1M') {
    return 30 * 24 * 60 * 60 * 1000;
  }

  return 60 * 60 * 1000;
};

export const validateStrategyBinding = (binding: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol' | 'interval' | 'base_coef' | 'quote_coef'>): void => {
  const base = normalizeSymbol(binding.base_symbol);
  const quote = normalizeSymbol(binding.quote_symbol);
  const interval = String(binding.interval || '').trim();
  const baseCoef = Number(binding.base_coef);
  const quoteCoef = Number(binding.quote_coef);
  const marketMode = normalizeMarketMode((binding as Partial<Strategy>).market_mode);

  if (!base) {
    throw new Error('Strategy requires a base symbol');
  }

  if (!interval) {
    throw new Error('Strategy interval is required');
  }

  if (!Number.isFinite(baseCoef)) {
    throw new Error('Strategy coefficients must be finite numbers');
  }

  if (marketMode === 'mono') {
    return;
  }

  if (!quote) {
    throw new Error('Synthetic strategy requires a quote symbol');
  }

  if (base === quote) {
    throw new Error('Base and quote symbols must be different');
  }

  if (!Number.isFinite(quoteCoef)) {
    throw new Error('Strategy coefficients must be finite numbers');
  }

  if (Math.abs(quoteCoef) < 1e-12) {
    throw new Error('Quote coefficient must not be zero');
  }
};

export const normalizeSymbolKey = (value: any): string => {
  return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
};

export const normalizeStrategy = (row: any): Strategy => {
  const strategyType = normalizeStrategyType(row.strategy_type);
  const marketMode = normalizeMarketMode(row.market_mode);
  const typeDefaults = getTypeAwareStrategyDefaults(strategyType);
  const mrs2Defaults = strategyType === 'MeanReversion' || strategyType === 'MRS2'
    ? { zscore_entry: 0.95, zscore_exit: 1.05, zscore_stop: 0.3 }
    : null;
  const zscoreEntry = normalizeZscoreEntry(
    row.zscore_entry,
    mrs2Defaults?.zscore_entry ?? DEFAULT_STRATEGY.zscore_entry,
  );
  // MRS2 remaps zscore_* to MA mults / distance_filter — do NOT clamp exit<entry or stop>entry.
  const zscoreExit = mrs2Defaults
    ? Math.max(0, safeNumber(row.zscore_exit, mrs2Defaults.zscore_exit))
    : normalizeZscoreExit(row.zscore_exit, DEFAULT_STRATEGY.zscore_exit, zscoreEntry);
  const zscoreStop = mrs2Defaults
    ? Math.max(0, safeNumber(row.zscore_stop, mrs2Defaults.zscore_stop))
    : normalizeZscoreStop(row.zscore_stop, DEFAULT_STRATEGY.zscore_stop, zscoreEntry);
  const mrs2ConfigJson = (() => {
    const raw = row.mrs2_config_json;
    if (raw == null) return '{}';
    if (typeof raw === 'string') return raw.trim() || '{}';
    try {
      return JSON.stringify(raw);
    } catch {
      return '{}';
    }
  })();
  const mrs2PendingJson = (() => {
    const raw = row.mrs2_pending_json;
    if (raw == null) return '{}';
    if (typeof raw === 'string') return raw.trim() || '{}';
    try {
      return JSON.stringify(raw);
    } catch {
      return '{}';
    }
  })();

  return {
    id: Number(row.id),
    name: String(row.name || DEFAULT_STRATEGY.name),
    api_key_id: Number(row.api_key_id),
    strategy_type: strategyType,
    market_mode: marketMode,
    market_type: (String(row.market_type || 'futures') === 'spot' ? 'spot' : 'futures') as 'futures' | 'spot',
    is_active: safeBoolean(row.is_active, true),
    display_on_chart: safeBoolean(row.display_on_chart, true),
    show_settings: safeBoolean(row.show_settings, true),
    show_chart: safeBoolean(row.show_chart, true),
    show_indicators: safeBoolean(row.show_indicators, true),
    show_positions_on_chart: safeBoolean(row.show_positions_on_chart, true),
    show_trades_on_chart: safeBoolean(row.show_trades_on_chart, false),
    show_values_each_bar: safeBoolean(row.show_values_each_bar, false),
    auto_update: safeBoolean(row.auto_update, true),
    take_profit_percent: safeNumber(row.take_profit_percent, typeDefaults.take_profit_percent),
    price_channel_length: Math.max(2, Math.floor(safeNumber(row.price_channel_length, typeDefaults.price_channel_length))),
    detection_source: String(row.detection_source || typeDefaults.detection_source) === 'wick' ? 'wick' : 'close',
    zscore_entry: zscoreEntry,
    zscore_exit: zscoreExit,
    zscore_stop: zscoreStop,
    mrs2_config_json: mrs2ConfigJson,
    mrs2_pending_json: mrs2PendingJson,
    base_symbol: normalizeSymbol(String(row.base_symbol || DEFAULT_STRATEGY.base_symbol)),
    quote_symbol: marketMode === 'mono'
      ? normalizeSymbol(String(row.quote_symbol || ''))
      : normalizeSymbol(String(row.quote_symbol || DEFAULT_STRATEGY.quote_symbol)),
    interval: String(row.interval || DEFAULT_STRATEGY.interval),
    base_coef: safeNumber(row.base_coef, DEFAULT_STRATEGY.base_coef),
    quote_coef: marketMode === 'mono' ? safeNumber(row.quote_coef, 0) : safeNumber(row.quote_coef, DEFAULT_STRATEGY.quote_coef),
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
    tp_anchor_ratio: row.tp_anchor_ratio === null || row.tp_anchor_ratio === undefined ? null : safeNumber(row.tp_anchor_ratio, 0),
    last_signal: row.last_signal === undefined ? null : row.last_signal,
    last_action: row.last_action === undefined ? null : row.last_action,
    partial_tp_pct: safeNumber(row.partial_tp_pct, DEFAULT_STRATEGY.partial_tp_pct ?? 0),
    last_error: row.last_error === undefined ? null : row.last_error,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
};

export const getStrategySymbols = (strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>): string[] => {
  const marketMode = normalizeMarketMode(strategy.market_mode);
  if (marketMode === 'mono') {
    return [strategy.base_symbol].filter((symbol) => Boolean(String(symbol || '').trim()));
  }

  return Array.from(
    new Set(
      [strategy.base_symbol, strategy.quote_symbol].filter((symbol) => Boolean(String(symbol || '').trim()))
    )
  );
};

export const getStrategyPairKey = (strategy: Pick<Strategy, 'market_mode' | 'base_symbol' | 'quote_symbol'>): string => {
  const mode = normalizeMarketMode(strategy.market_mode);
  const base = normalizeSymbol(String(strategy.base_symbol || ''));
  const quote = mode === 'mono'
    ? ''
    : normalizeSymbol(String(strategy.quote_symbol || ''));
  return mode === 'mono' ? `mono:${base}` : `synthetic:${base}/${quote}`;
};


import { db } from '../utils/database';

export interface ApiKey {
  id?: number;
  name: string;
  exchange: string;
  api_key: string;
  secret: string;
  passphrase?: string;
  speed_limit: number;
  testnet?: boolean;
  demo?: boolean;
}

export interface RiskSettings {
  id?: number;
  api_key_id: number;
  long_enabled: boolean;
  short_enabled: boolean;
  lot_long_percent: number;
  lot_short_percent: number;
  max_deposit: number;
  margin_type: 'cross' | 'isolated';
  leverage: number;
  fixed_lot: boolean;
  reinvest_percent: number;
}

export type StrategyType = 'DD_BattleToads' | 'stat_arb_zscore' | 'zz_breakout';
export type MarketMode = 'synthetic' | 'mono';

export interface Strategy {
  id?: number;
  name: string;
  api_key_id: number;
  strategy_type?: StrategyType;
  market_mode: MarketMode;
  is_active: boolean;
  display_on_chart: boolean;
  show_settings: boolean;
  show_chart: boolean;
  show_indicators: boolean;
  show_positions_on_chart: boolean;
  show_trades_on_chart?: boolean;
  show_values_each_bar: boolean;
  auto_update: boolean;
  take_profit_percent: number;
  price_channel_length: number;
  detection_source: 'wick' | 'close';
  zscore_entry: number;
  zscore_exit: number;
  zscore_stop: number;
  base_symbol: string;
  quote_symbol: string;
  interval: string;
  base_coef: number;
  quote_coef: number;
  long_enabled: boolean;
  short_enabled: boolean;
  lot_long_percent: number;
  lot_short_percent: number;
  max_deposit: number;
  margin_type: 'cross' | 'isolated';
  leverage: number;
  fixed_lot: boolean;
  reinvest_percent: number;
  state?: 'flat' | 'long' | 'short';
  entry_ratio?: number | null;
  tp_anchor_ratio?: number | null;
  last_signal?: string | null;
  last_action?: string | null;
  last_error?: string | null;
  lot_long_usdt?: number | null;
  lot_short_usdt?: number | null;
  lot_balance_usdt?: number | null;
  created_at?: string;
  updated_at?: string;
}

export const loadSettings = async () => {
  // Загрузка настроек из БД
  const apiKeys = await db.all('SELECT * FROM api_keys');
  const riskSettings = await db.all('SELECT * FROM risk_settings');
  const strategies = await db.all('SELECT * FROM strategies');

  return { apiKeys, riskSettings, strategies };
};

export const saveApiKey = async (key: ApiKey) => {
  await db.run(
    'INSERT OR REPLACE INTO api_keys (name, exchange, api_key, secret, passphrase, speed_limit, testnet, demo) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    [
      key.name,
      key.exchange,
      key.api_key,
      key.secret,
      key.passphrase || '',
      key.speed_limit || 10,
      key.testnet ? 1 : 0,
      key.demo ? 1 : 0,
    ]
  );
};

export const saveRiskSettings = async (settings: RiskSettings) => {
  await db.run(
    `INSERT INTO risk_settings (
      api_key_id,
      long_enabled,
      short_enabled,
      lot_long_percent,
      lot_short_percent,
      max_deposit,
      margin_type,
      leverage,
      fixed_lot,
      reinvest_percent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(api_key_id) DO UPDATE SET
      long_enabled = excluded.long_enabled,
      short_enabled = excluded.short_enabled,
      lot_long_percent = excluded.lot_long_percent,
      lot_short_percent = excluded.lot_short_percent,
      max_deposit = excluded.max_deposit,
      margin_type = excluded.margin_type,
      leverage = excluded.leverage,
      fixed_lot = excluded.fixed_lot,
      reinvest_percent = excluded.reinvest_percent`,
    [
      settings.api_key_id,
      settings.long_enabled ? 1 : 0,
      settings.short_enabled ? 1 : 0,
      settings.lot_long_percent,
      settings.lot_short_percent,
      settings.max_deposit,
      settings.margin_type,
      settings.leverage,
      settings.fixed_lot ? 1 : 0,
      settings.reinvest_percent,
    ]
  );
};

export const saveStrategy = async (strategy: Strategy) => {
  await db.run(
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
      show_values_each_bar,
      auto_update,
      take_profit_percent,
      price_channel_length,
      detection_source,
      zscore_entry,
      zscore_exit,
      zscore_stop,
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
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      strategy.name,
      strategy.api_key_id,
      strategy.strategy_type || 'DD_BattleToads',
      strategy.market_mode,
      strategy.is_active,
      strategy.display_on_chart,
      strategy.show_settings,
      strategy.show_chart,
      strategy.show_indicators,
      strategy.show_positions_on_chart,
      strategy.show_values_each_bar,
      strategy.auto_update,
      strategy.take_profit_percent,
      strategy.price_channel_length,
      strategy.detection_source,
      strategy.zscore_entry,
      strategy.zscore_exit,
      strategy.zscore_stop,
      strategy.base_symbol,
      strategy.quote_symbol,
      strategy.interval,
      strategy.base_coef,
      strategy.quote_coef,
      strategy.long_enabled,
      strategy.short_enabled,
      strategy.lot_long_percent,
      strategy.lot_short_percent,
      strategy.max_deposit,
      strategy.margin_type,
      strategy.leverage,
      strategy.fixed_lot,
      strategy.reinvest_percent,
      strategy.state || 'flat',
      strategy.entry_ratio ?? null,
      strategy.tp_anchor_ratio ?? null,
      strategy.last_signal ?? null,
      strategy.last_action ?? null,
      strategy.last_error ?? null,
    ]
  );
};

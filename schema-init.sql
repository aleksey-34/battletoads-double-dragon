PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;

DROP INDEX IF EXISTS idx_chart_settings_api_key_unique;
DROP TABLE IF EXISTS chart_settings;

CREATE TABLE IF NOT EXISTS api_keys (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE,
  exchange TEXT,
  api_key TEXT,
  secret TEXT,
  passphrase TEXT DEFAULT '',
  speed_limit INTEGER DEFAULT 10,
  testnet BOOLEAN DEFAULT 0,
  demo BOOLEAN DEFAULT 0
);

CREATE TABLE IF NOT EXISTS risk_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER,
  long_enabled BOOLEAN DEFAULT 1,
  short_enabled BOOLEAN DEFAULT 0,
  lot_long_percent REAL DEFAULT 1.0,
  lot_short_percent REAL DEFAULT 1.0,
  max_deposit REAL DEFAULT 1000.0,
  margin_type TEXT DEFAULT 'cross',
  leverage REAL DEFAULT 1.0,
  fixed_lot BOOLEAN DEFAULT 0,
  reinvest_percent REAL DEFAULT 0.0,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE TABLE IF NOT EXISTS strategies (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT,
  api_key_id INTEGER,
  strategy_type TEXT DEFAULT 'DD_BattleToads',
  market_mode TEXT DEFAULT 'synthetic',
  is_active BOOLEAN DEFAULT 1,
  display_on_chart BOOLEAN DEFAULT 1,
  show_settings BOOLEAN DEFAULT 1,
  show_chart BOOLEAN DEFAULT 1,
  show_indicators BOOLEAN DEFAULT 1,
  show_positions_on_chart BOOLEAN DEFAULT 1,
  show_trades_on_chart BOOLEAN DEFAULT 0,
  show_values_each_bar BOOLEAN DEFAULT 0,
  auto_update BOOLEAN DEFAULT 1,
  take_profit_percent REAL DEFAULT 7.5,
  price_channel_length INTEGER DEFAULT 50,
  detection_source TEXT DEFAULT 'close',
  zscore_entry REAL DEFAULT 2.0,
  zscore_exit REAL DEFAULT 0.5,
  zscore_stop REAL DEFAULT 3.5,
  base_symbol TEXT,
  quote_symbol TEXT,
  interval TEXT DEFAULT '1h',
  base_coef REAL DEFAULT 1.0,
  quote_coef REAL DEFAULT 1.0,
  long_enabled BOOLEAN DEFAULT 1,
  short_enabled BOOLEAN DEFAULT 1,
  lot_long_percent REAL DEFAULT 100.0,
  lot_short_percent REAL DEFAULT 100.0,
  max_deposit REAL DEFAULT 1000.0,
  margin_type TEXT DEFAULT 'cross',
  leverage REAL DEFAULT 1.0,
  fixed_lot BOOLEAN DEFAULT 0,
  reinvest_percent REAL DEFAULT 0.0,
  state TEXT DEFAULT 'flat',
  entry_ratio REAL,
  tp_anchor_ratio REAL,
  last_signal TEXT,
  last_action TEXT,
  last_error TEXT,
  is_runtime BOOLEAN DEFAULT 0,
  is_archived BOOLEAN DEFAULT 0,
  origin TEXT DEFAULT 'manual',
  source_profile_id INTEGER,
  published_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE TABLE IF NOT EXISTS monitoring_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  exchange TEXT,
  equity_usd REAL DEFAULT 0,
  unrealized_pnl REAL DEFAULT 0,
  margin_used_usd REAL DEFAULT 0,
  margin_load_percent REAL DEFAULT 0,
  effective_leverage REAL DEFAULT 0,
  notional_usd REAL DEFAULT 0,
  drawdown_percent REAL DEFAULT 0,
  recorded_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE TABLE IF NOT EXISTS backtest_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_name TEXT NOT NULL,
  mode TEXT NOT NULL,
  strategy_ids TEXT NOT NULL,
  strategy_names TEXT NOT NULL,
  interval TEXT DEFAULT '1h',
  bars INTEGER DEFAULT 0,
  initial_balance REAL DEFAULT 0,
  final_equity REAL DEFAULT 0,
  total_return_percent REAL DEFAULT 0,
  max_drawdown_percent REAL DEFAULT 0,
  trades_count INTEGER DEFAULT 0,
  win_rate_percent REAL DEFAULT 0,
  profit_factor REAL DEFAULT 0,
  commission_percent REAL DEFAULT 0,
  slippage_percent REAL DEFAULT 0,
  funding_rate_percent REAL DEFAULT 0,
  request_json TEXT,
  summary_json TEXT,
  equity_curve_json TEXT,
  trades_json TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS trading_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  is_active BOOLEAN DEFAULT 0,
  auto_sync_members BOOLEAN DEFAULT 0,
  discovery_enabled BOOLEAN DEFAULT 0,
  discovery_interval_hours INTEGER DEFAULT 24,
  max_members INTEGER DEFAULT 8,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
);

CREATE TABLE IF NOT EXISTS trading_system_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  system_id INTEGER NOT NULL,
  strategy_id INTEGER NOT NULL,
  weight REAL DEFAULT 1.0,
  member_role TEXT DEFAULT 'core',
  is_enabled BOOLEAN DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (system_id) REFERENCES trading_systems(id),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  UNIQUE(system_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS master_cards (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  source_system_id INTEGER,
  is_active BOOLEAN DEFAULT 1,
  metadata_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (source_system_id) REFERENCES trading_systems(id)
);

CREATE TABLE IF NOT EXISTS master_card_members (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  strategy_id INTEGER NOT NULL,
  weight REAL DEFAULT 1.0,
  member_role TEXT DEFAULT 'core',
  is_enabled BOOLEAN DEFAULT 1,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (card_id) REFERENCES master_cards(id),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id),
  UNIQUE(card_id, strategy_id)
);

CREATE TABLE IF NOT EXISTS card_deployments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  card_id INTEGER NOT NULL,
  tenant_id INTEGER,
  execution_api_key_name TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  materialized_system_id INTEGER,
  materialized_at TEXT,
  last_sync_at TEXT,
  sync_status TEXT DEFAULT 'idle',
  sync_error TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (card_id) REFERENCES master_cards(id),
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (materialized_system_id) REFERENCES trading_systems(id)
);

CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_api_time
  ON monitoring_snapshots (api_key_id, recorded_at);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_created_at
  ON backtest_runs (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_backtest_runs_api_key_name
  ON backtest_runs (api_key_name);

CREATE INDEX IF NOT EXISTS idx_trading_systems_api_key_id
  ON trading_systems (api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_trading_system_members_system_id
  ON trading_system_members (system_id, is_enabled);

CREATE INDEX IF NOT EXISTS idx_master_cards_active
  ON master_cards (is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_master_card_members_card_id
  ON master_card_members (card_id, is_enabled);

CREATE INDEX IF NOT EXISTS idx_card_deployments_api_key
  ON card_deployments (execution_api_key_name, status, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_card_deployments_card_id
  ON card_deployments (card_id, status, updated_at DESC);

CREATE TABLE IF NOT EXISTS live_trade_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  trade_type TEXT NOT NULL CHECK(trade_type IN ('entry', 'exit')),
  side TEXT NOT NULL CHECK(side IN ('long', 'short')),
  entry_time INTEGER NOT NULL,
  entry_price REAL NOT NULL,
  position_size REAL NOT NULL,
  actual_price REAL NOT NULL,
  actual_time INTEGER NOT NULL,
  actual_fee REAL DEFAULT 0,
  slippage_percent REAL DEFAULT 0,
  source_trade_id TEXT,
  source_order_id TEXT,
  source_symbol TEXT,
  backtest_predicted_price REAL,
  backtest_predicted_time INTEGER,
  backtest_predicted_fee REAL,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER)),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

CREATE TABLE IF NOT EXISTS backtest_predictions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  side TEXT NOT NULL CHECK(side IN ('long', 'short')),
  predicted_entry_price REAL NOT NULL,
  predicted_entry_time INTEGER NOT NULL,
  predicted_exit_price REAL NOT NULL,
  predicted_exit_time INTEGER NOT NULL,
  predicted_pnl REAL NOT NULL,
  predicted_pnl_percent REAL NOT NULL,
  predicted_slippage_percent REAL DEFAULT 0.05,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER)),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

CREATE TABLE IF NOT EXISTS drift_alerts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  strategy_id INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  severity TEXT NOT NULL CHECK(severity IN ('warning', 'critical')),
  value REAL NOT NULL,
  threshold REAL NOT NULL,
  drift_percent REAL NOT NULL,
  description TEXT NOT NULL,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER)),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

CREATE TABLE IF NOT EXISTS reconciliation_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  strategy_id INTEGER NOT NULL,
  period_hours INTEGER NOT NULL,
  samples_count INTEGER DEFAULT 0,
  metrics_json TEXT NOT NULL,
  recommendation_json TEXT NOT NULL,
  action_note TEXT DEFAULT '',
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER)),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  FOREIGN KEY (strategy_id) REFERENCES strategies(id)
);

CREATE TABLE IF NOT EXISTS liquidity_scan_suggestions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_id INTEGER NOT NULL,
  system_id INTEGER NOT NULL,
  symbol TEXT NOT NULL,
  market_mode TEXT NOT NULL DEFAULT 'mono',
  suggested_action TEXT NOT NULL,
  score REAL DEFAULT 0,
  details_json TEXT DEFAULT '{}',
  status TEXT DEFAULT 'new',
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER)),
  FOREIGN KEY (api_key_id) REFERENCES api_keys(id),
  FOREIGN KEY (system_id) REFERENCES trading_systems(id)
);

CREATE INDEX IF NOT EXISTS idx_live_trade_events_strategy_time
  ON live_trade_events (strategy_id, actual_time DESC);

CREATE INDEX IF NOT EXISTS idx_backtest_predictions_strategy_time
  ON backtest_predictions (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_drift_alerts_strategy_time
  ON drift_alerts (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_api_key_time
  ON reconciliation_reports (api_key_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_reconciliation_reports_strategy_time
  ON reconciliation_reports (strategy_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_liquidity_scan_suggestions_system_time
  ON liquidity_scan_suggestions (system_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_liquidity_scan_suggestions_status
  ON liquidity_scan_suggestions (api_key_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS plans (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT NOT NULL,
  product_mode TEXT NOT NULL,
  price_usdt REAL DEFAULT 0,
  max_deposit_total REAL DEFAULT 0,
  risk_cap_max REAL DEFAULT 0,
  max_strategies_total INTEGER DEFAULT 0,
  allow_ts_start_stop_requests BOOLEAN DEFAULT 0,
  features_json TEXT DEFAULT '{}',
  is_active BOOLEAN DEFAULT 1,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS tenants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  product_mode TEXT NOT NULL,
  status TEXT DEFAULT 'active',
  preferred_language TEXT DEFAULT 'ru',
  assigned_api_key_name TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS client_users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  email TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT DEFAULT '',
  preferred_language TEXT DEFAULT 'en',
  status TEXT DEFAULT 'active',
  onboarding_completed_at TEXT,
  last_login_at TEXT,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS client_sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  last_seen_at TEXT DEFAULT CURRENT_TIMESTAMP,
  ip TEXT DEFAULT '',
  user_agent TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (user_id) REFERENCES client_users(id)
);

CREATE TABLE IF NOT EXISTS client_magic_links (
  id TEXT PRIMARY KEY,
  tenant_id INTEGER NOT NULL,
  user_id INTEGER NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  note TEXT DEFAULT '',
  created_by TEXT DEFAULT 'platform_admin',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (user_id) REFERENCES client_users(id)
);

CREATE TABLE IF NOT EXISTS subscriptions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  plan_id INTEGER NOT NULL,
  status TEXT DEFAULT 'active',
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  expires_at TEXT,
  notes TEXT DEFAULT '',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id),
  FOREIGN KEY (plan_id) REFERENCES plans(id)
);

CREATE TABLE IF NOT EXISTS strategy_client_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  selected_offer_ids_json TEXT DEFAULT '[]',
  active_system_profile_id INTEGER,
  risk_level TEXT DEFAULT 'medium',
  trade_frequency_level TEXT DEFAULT 'medium',
  requested_enabled BOOLEAN DEFAULT 0,
  actual_enabled BOOLEAN DEFAULT 0,
  assigned_api_key_name TEXT DEFAULT '',
  latest_preview_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS strategy_client_system_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  profile_name TEXT NOT NULL,
  selected_offer_ids_json TEXT DEFAULT '[]',
  is_active BOOLEAN DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS algofund_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  risk_multiplier REAL DEFAULT 1,
  requested_enabled BOOLEAN DEFAULT 0,
  actual_enabled BOOLEAN DEFAULT 0,
  assigned_api_key_name TEXT DEFAULT '',
  execution_api_key_name TEXT DEFAULT '',
  published_system_name TEXT DEFAULT '',
  latest_preview_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS copytrading_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  master_api_key_name TEXT DEFAULT '',
  master_name TEXT DEFAULT '',
  master_tags TEXT DEFAULT 'copytrading-master',
  tenants_json TEXT DEFAULT '[]',
  copy_algorithm TEXT DEFAULT 'vwap_basic',
  copy_precision TEXT DEFAULT 'standard',
  copy_enabled BOOLEAN DEFAULT 0,
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS algofund_start_stop_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  request_type TEXT NOT NULL,
  status TEXT DEFAULT 'pending',
  note TEXT DEFAULT '',
  decision_note TEXT DEFAULT '',
  request_payload_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS strategy_backtest_pair_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  base_symbol TEXT NOT NULL,
  quote_symbol TEXT DEFAULT '',
  interval TEXT DEFAULT '1h',
  note TEXT DEFAULT '',
  status TEXT DEFAULT 'pending',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  decided_at TEXT,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS saas_audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER,
  actor_mode TEXT DEFAULT 'admin',
  action TEXT NOT NULL,
  payload_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE TABLE IF NOT EXISTS app_runtime_flags (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_plans_product_mode
  ON plans (product_mode, is_active);

CREATE TABLE IF NOT EXISTS strategy_runtime_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  api_key_name TEXT NOT NULL,
  strategy_id INTEGER,
  strategy_name TEXT DEFAULT '',
  event_type TEXT NOT NULL,
  message TEXT NOT NULL,
  details_json TEXT DEFAULT '{}',
  resolved_at INTEGER DEFAULT 0,
  created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER))
);

CREATE INDEX IF NOT EXISTS idx_sre_lookup
  ON strategy_runtime_events (api_key_name, event_type, resolved_at, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_sre_strategy
  ON strategy_runtime_events (strategy_id, event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_tenants_product_mode
  ON tenants (product_mode, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_users_tenant
  ON client_users (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_client_sessions_user
  ON client_sessions (user_id, revoked_at, expires_at);

CREATE INDEX IF NOT EXISTS idx_client_sessions_hash
  ON client_sessions (token_hash);

CREATE INDEX IF NOT EXISTS idx_client_magic_links_hash
  ON client_magic_links (token_hash);

CREATE INDEX IF NOT EXISTS idx_subscriptions_tenant
  ON subscriptions (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_algofund_requests_tenant
  ON algofund_start_stop_requests (tenant_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_copytrading_profiles_tenant
  ON copytrading_profiles (tenant_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_backtest_pair_requests_tenant
  ON strategy_backtest_pair_requests (tenant_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS synctrade_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  master_api_key_name TEXT DEFAULT '',
  master_display_name TEXT DEFAULT '',
  symbol TEXT DEFAULT 'BTCUSDT',
  hedge_accounts_json TEXT DEFAULT '[]',
  mode TEXT DEFAULT 'hedge_pnl',
  target_profit_percent REAL DEFAULT 50.0,
  target_mode TEXT DEFAULT 'percent',
  target_value REAL DEFAULT 50.0,
  max_accounts INTEGER DEFAULT 5,
  interval_ms INTEGER DEFAULT 500,
  enabled BOOLEAN DEFAULT 0,
  last_run_at TEXT,
  last_result_json TEXT DEFAULT '{}',
  created_at TEXT DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (tenant_id) REFERENCES tenants(id)
);

CREATE INDEX IF NOT EXISTS idx_synctrade_profiles_tenant
  ON synctrade_profiles (tenant_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS synctrade_sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL,
  status TEXT DEFAULT 'pending',
  symbol TEXT NOT NULL,
  master_side TEXT NOT NULL,
  entry_price REAL,
  exit_price REAL,
  master_pnl REAL DEFAULT 0,
  hedge_pnl_json TEXT DEFAULT '{}',
  total_pnl REAL DEFAULT 0,
  duration_ms INTEGER DEFAULT 0,
  error TEXT,
  log_json TEXT DEFAULT '[]',
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES synctrade_profiles(id)
);

CREATE INDEX IF NOT EXISTS idx_synctrade_sessions_profile
  ON synctrade_sessions (profile_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_strategy_client_system_profiles_tenant
  ON strategy_client_system_profiles (tenant_id, is_active, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_saas_audit_tenant
  ON saas_audit_log (tenant_id, created_at DESC);

DELETE FROM risk_settings
WHERE api_key_id IS NOT NULL
  AND id NOT IN (
    SELECT MAX(id)
    FROM risk_settings
    GROUP BY api_key_id
  );

CREATE UNIQUE INDEX IF NOT EXISTS idx_risk_settings_api_key_unique
  ON risk_settings (api_key_id);

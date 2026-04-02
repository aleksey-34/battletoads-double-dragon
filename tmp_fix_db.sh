#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db
sqlite3 "$DB" <<'SQL'
CREATE TABLE IF NOT EXISTS synctrade_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL UNIQUE,
  master_api_key_name TEXT DEFAULT '',
  master_display_name TEXT DEFAULT '',
  symbol TEXT DEFAULT 'BTCUSDT',
  hedge_accounts_json TEXT DEFAULT '[]',
  mode TEXT DEFAULT 'hedge_pnl',
  target_profit_percent REAL DEFAULT 50.0,
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
  started_at TEXT DEFAULT CURRENT_TIMESTAMP,
  finished_at TEXT,
  FOREIGN KEY (profile_id) REFERENCES synctrade_profiles(id)
);
CREATE INDEX IF NOT EXISTS idx_synctrade_sessions_profile
  ON synctrade_sessions (profile_id, started_at DESC);
SQL
echo "synctrade tables: OK"
sqlite3 "$DB" ".tables" | tr ' ' '\n' | grep synctrade

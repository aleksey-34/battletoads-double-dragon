import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';

let db: Database<sqlite3.Database, sqlite3.Statement>;

export const initDB = async () => {
  db = await open({
    filename: './database.db',
    driver: sqlite3.Database,
  });

  const ensureColumn = async (table: string, columnDefinition: string) => {
    try {
      await db.exec(`ALTER TABLE ${table} ADD COLUMN ${columnDefinition}`);
    } catch (error) {
      const message = String(error);
      if (!message.includes('duplicate column name')) {
        throw error;
      }
    }
  };

  // Создание таблиц
  await db.exec(`
    CREATE TABLE IF NOT EXISTS api_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE,
      exchange TEXT,
      api_key TEXT,
      secret TEXT,
      passphrase TEXT DEFAULT '',
      speed_limit INTEGER DEFAULT 10,
      testnet BOOLEAN DEFAULT 0
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

    CREATE TABLE IF NOT EXISTS chart_settings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER,
      display_chart BOOLEAN DEFAULT 1,
      mono_chart_symbol TEXT,
      mono_chart_tf TEXT,
      synthetic_base TEXT,
      synthetic_quote TEXT,
      synthetic_formula TEXT,
      synthetic_tf TEXT,
      min_daily_volume REAL DEFAULT 0,
      FOREIGN KEY (api_key_id) REFERENCES api_keys(id)
    );

    CREATE TABLE IF NOT EXISTS strategies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      api_key_id INTEGER,
      strategy_type TEXT DEFAULT 'DD_BattleToads',
      is_active BOOLEAN DEFAULT 1,
      display_on_chart BOOLEAN DEFAULT 1,
      show_settings BOOLEAN DEFAULT 1,
      show_chart BOOLEAN DEFAULT 1,
      show_indicators BOOLEAN DEFAULT 1,
      show_positions_on_chart BOOLEAN DEFAULT 1,
      show_values_each_bar BOOLEAN DEFAULT 0,
      auto_update BOOLEAN DEFAULT 1,
      take_profit_percent REAL DEFAULT 7.5,
      price_channel_length INTEGER DEFAULT 50,
      detection_source TEXT DEFAULT 'close',
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
      last_signal TEXT,
      last_action TEXT,
      last_error TEXT,
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

    CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_api_time
      ON monitoring_snapshots (api_key_id, recorded_at);
  `);

  await ensureColumn('api_keys', 'testnet BOOLEAN DEFAULT 0');
  await ensureColumn('api_keys', 'demo BOOLEAN DEFAULT 0');
  await ensureColumn('api_keys', "passphrase TEXT DEFAULT ''");
  await ensureColumn('strategies', "strategy_type TEXT DEFAULT 'DD_BattleToads'");
  await ensureColumn('strategies', 'show_settings BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'take_profit_percent REAL DEFAULT 7.5');
  await ensureColumn('strategies', 'show_chart BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'show_indicators BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'show_positions_on_chart BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'show_values_each_bar BOOLEAN DEFAULT 0');
  await ensureColumn('strategies', 'auto_update BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'price_channel_length INTEGER DEFAULT 50');
  await ensureColumn('strategies', "detection_source TEXT DEFAULT 'close'");
  await ensureColumn('strategies', 'base_symbol TEXT');
  await ensureColumn('strategies', 'quote_symbol TEXT');
  await ensureColumn('strategies', "interval TEXT DEFAULT '1h'");
  await ensureColumn('strategies', 'base_coef REAL DEFAULT 1.0');
  await ensureColumn('strategies', 'quote_coef REAL DEFAULT 1.0');
  await ensureColumn('strategies', 'long_enabled BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'short_enabled BOOLEAN DEFAULT 1');
  await ensureColumn('strategies', 'lot_long_percent REAL DEFAULT 100.0');
  await ensureColumn('strategies', 'lot_short_percent REAL DEFAULT 100.0');
  await ensureColumn('strategies', 'max_deposit REAL DEFAULT 1000.0');
  await ensureColumn('strategies', "margin_type TEXT DEFAULT 'cross'");
  await ensureColumn('strategies', 'leverage REAL DEFAULT 1.0');
  await ensureColumn('strategies', 'fixed_lot BOOLEAN DEFAULT 0');
  await ensureColumn('strategies', 'reinvest_percent REAL DEFAULT 0.0');
  await ensureColumn('strategies', "state TEXT DEFAULT 'flat'");
  await ensureColumn('strategies', 'entry_ratio REAL');
  await ensureColumn('strategies', 'last_signal TEXT');
  await ensureColumn('strategies', 'last_action TEXT');
  await ensureColumn('strategies', 'last_error TEXT');
  await ensureColumn('strategies', 'created_at TEXT DEFAULT CURRENT_TIMESTAMP');
  await ensureColumn('strategies', 'updated_at TEXT DEFAULT CURRENT_TIMESTAMP');
};

export { db };
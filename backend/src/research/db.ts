/**
 * Research circuit database (research.db)
 *
 * Isolated from runtime.db and main.db.
 * Stores: strategy_profiles, sweep_runs, sweep_artifacts,
 *         preview_jobs, client_presets, publish_log, backtest_runs.
 *
 * NEVER import trading-engine logic that writes to runtime here.
 * Research DB is admin-only; clients access pre-baked presets via client API.
 */
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import logger from '../utils/logger';

// Locate DB file next to the main application data directory
const DB_PATH =
  process.env.RESEARCH_DB_PATH ||
  path.resolve(process.cwd(), 'research.db');

let _db: Database<sqlite3.Database, sqlite3.Statement> | null = null;

export const getResearchDb = (): Database<sqlite3.Database, sqlite3.Statement> => {
  if (!_db) {
    throw new Error('Research DB not initialized. Call initResearchDb() first.');
  }
  return _db;
};

export const initResearchDb = async (): Promise<void> => {
  if (_db) {
    return;
  }

  logger.info(`Opening research DB at: ${DB_PATH}`);
  _db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await _db.exec('PRAGMA journal_mode = WAL;');
  await _db.exec('PRAGMA foreign_keys = ON;');
  await _db.exec('PRAGMA busy_timeout = 5000;');

  await applySchema(_db);
  logger.info('Research DB initialized');
};

const applySchema = async (db: Database<sqlite3.Database, sqlite3.Statement>): Promise<void> => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS strategy_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      origin TEXT DEFAULT 'sweep_candidate',
      strategy_type TEXT NOT NULL DEFAULT 'DD_BattleToads',
      market_mode TEXT DEFAULT 'mono',
      base_symbol TEXT,
      quote_symbol TEXT,
      interval TEXT DEFAULT '1h',
      config_json TEXT NOT NULL DEFAULT '{}',
      metrics_summary_json TEXT DEFAULT '{}',
      sweep_run_id INTEGER,
      published_strategy_id INTEGER,
      status TEXT DEFAULT 'candidate',
      tags_json TEXT DEFAULT '[]',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_status
      ON strategy_profiles (status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_profiles_sweep
      ON strategy_profiles (sweep_run_id, status);

    CREATE TABLE IF NOT EXISTS sweep_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT DEFAULT '',
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'queued',
      progress_json TEXT DEFAULT '{}',
      result_summary_json TEXT DEFAULT '{}',
      artifact_file_path TEXT,
      catalog_file_path TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_sweeps_status
      ON sweep_runs (status, created_at DESC);

    CREATE TABLE IF NOT EXISTS sweep_artifacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      sweep_run_id INTEGER NOT NULL,
      artifact_type TEXT NOT NULL,
      file_path TEXT,
      content_json TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (sweep_run_id) REFERENCES sweep_runs(id)
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_sweep
      ON sweep_artifacts (sweep_run_id, artifact_type);

    CREATE TABLE IF NOT EXISTS profile_metrics_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL UNIQUE,
      config_hash TEXT NOT NULL,
      metrics_json TEXT NOT NULL,
      computed_at TEXT DEFAULT CURRENT_TIMESTAMP,
      expires_at TEXT,
      FOREIGN KEY (profile_id) REFERENCES strategy_profiles(id)
    );

    CREATE TABLE IF NOT EXISTS preview_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER,
      config_json TEXT NOT NULL,
      config_hash TEXT NOT NULL,
      status TEXT DEFAULT 'queued',
      priority INTEGER DEFAULT 0,
      result_json TEXT,
      error TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      started_at TEXT,
      completed_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_preview_jobs_status
      ON preview_jobs (status, priority DESC, created_at ASC);
    CREATE INDEX IF NOT EXISTS idx_preview_jobs_hash
      ON preview_jobs (config_hash, status);

    CREATE TABLE IF NOT EXISTS client_presets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      offer_id TEXT NOT NULL,
      risk_level TEXT NOT NULL,
      freq_level TEXT NOT NULL,
      config_json TEXT NOT NULL DEFAULT '{}',
      metrics_json TEXT NOT NULL DEFAULT '{}',
      equity_curve_json TEXT DEFAULT '[]',
      sweep_run_id INTEGER,
      is_current BOOLEAN DEFAULT 1,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      UNIQUE (offer_id, risk_level, freq_level)
    );

    CREATE INDEX IF NOT EXISTS idx_presets_offer
      ON client_presets (offer_id, is_current);

    CREATE TABLE IF NOT EXISTS publish_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL,
      runtime_strategy_id INTEGER,
      action TEXT DEFAULT 'publish',
      published_by TEXT DEFAULT 'admin',
      notes TEXT DEFAULT '',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES strategy_profiles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_publish_log_profile
      ON publish_log (profile_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS backtest_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      profile_id INTEGER,
      config_json TEXT NOT NULL DEFAULT '{}',
      status TEXT DEFAULT 'queued',
      result_json TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (profile_id) REFERENCES strategy_profiles(id)
    );

    CREATE INDEX IF NOT EXISTS idx_backtest_runs_status
      ON backtest_runs (status, created_at DESC);
  `);
};

/** Gracefully close the research DB (call on process shutdown). */
export const closeResearchDb = async (): Promise<void> => {
  if (_db) {
    await _db.close();
    _db = null;
    logger.info('Research DB closed');
  }
};

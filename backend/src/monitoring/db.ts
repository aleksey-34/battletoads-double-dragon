/**
 * Monitoring database (monitoring.db)
 *
 * Isolated from main database.db so snapshot/fill writes do not contend
 * with the 20GB+ runtime/catalog SQLite file.
 *
 * Rows reference main.api_keys by api_key_id (same integer id) and optionally
 * api_key_name (denormalized for readability). Secrets stay in main only.
 */
import sqlite3 from 'sqlite3';
import { open, Database } from 'sqlite';
import path from 'path';
import fs from 'fs';
import logger from '../utils/logger';

const resolveMonitoringDbPath = (): string => {
  const envPath = String(process.env.MONITORING_DB_PATH || '').trim();
  if (envPath) return envPath;
  const envMain = String(process.env.DB_FILE || '').trim();
  if (envMain) {
    return path.join(path.dirname(envMain), 'monitoring.db');
  }
  return path.resolve(__dirname, '../../monitoring.db');
};

let DB_PATH = resolveMonitoringDbPath();
let _db: Database<sqlite3.Database, sqlite3.Statement> | null = null;
let _attachedToMain = false;

export const getMonitoringDbFilePath = (): string => DB_PATH;

export const getMonitoringDb = (): Database<sqlite3.Database, sqlite3.Statement> => {
  if (!_db) {
    throw new Error('Monitoring DB not initialized. Call initMonitoringDb() first.');
  }
  return _db;
};

const applySchema = async (db: Database<sqlite3.Database, sqlite3.Statement>): Promise<void> => {
  await db.exec(`
    CREATE TABLE IF NOT EXISTS monitoring_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS monitoring_snapshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      api_key_name TEXT,
      exchange TEXT,
      equity_usd REAL DEFAULT 0,
      unrealized_pnl REAL DEFAULT 0,
      margin_used_usd REAL DEFAULT 0,
      margin_load_percent REAL DEFAULT 0,
      effective_leverage REAL DEFAULT 0,
      notional_usd REAL DEFAULT 0,
      drawdown_percent REAL DEFAULT 0,
      deposit_base_usd REAL DEFAULT NULL,
      pnl_net_usd REAL DEFAULT NULL,
      source TEXT DEFAULT 'live',
      recorded_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_api_time
      ON monitoring_snapshots (api_key_id, recorded_at);

    CREATE INDEX IF NOT EXISTS idx_monitoring_snapshots_name_time
      ON monitoring_snapshots (api_key_name, recorded_at);

    CREATE TABLE IF NOT EXISTS exchange_fill_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      api_key_id INTEGER NOT NULL,
      api_key_name TEXT,
      trade_type TEXT NOT NULL CHECK(trade_type IN ('entry', 'exit')),
      side TEXT NOT NULL CHECK(side IN ('long', 'short')),
      source_trade_id TEXT NOT NULL,
      source_order_id TEXT,
      source_symbol TEXT,
      actual_price REAL NOT NULL,
      position_size REAL NOT NULL,
      actual_fee REAL DEFAULT 0,
      realized_pnl REAL DEFAULT 0,
      is_maker INTEGER DEFAULT 0,
      actual_time INTEGER NOT NULL,
      event_origin TEXT DEFAULT 'exchange_backfill',
      created_at INTEGER DEFAULT (CAST(strftime('%s','now') * 1000 AS INTEGER))
    );

    CREATE UNIQUE INDEX IF NOT EXISTS idx_exchange_fill_events_source
      ON exchange_fill_events (api_key_id, source_trade_id);

    CREATE INDEX IF NOT EXISTS idx_exchange_fill_events_key_time
      ON exchange_fill_events (api_key_id, actual_time DESC);
  `);
};

export const initMonitoringDb = async (): Promise<void> => {
  if (_db) return;

  DB_PATH = resolveMonitoringDbPath();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  logger.info(`Opening monitoring DB at: ${DB_PATH}`);
  _db = await open({
    filename: DB_PATH,
    driver: sqlite3.Database,
  });

  await _db.exec('PRAGMA journal_mode = WAL;');
  await _db.exec('PRAGMA busy_timeout = 120000;');
  await _db.exec('PRAGMA synchronous = NORMAL;');
  await _db.exec('PRAGMA wal_autocheckpoint = 1000;');

  await applySchema(_db);
  logger.info('Monitoring DB initialized');
};

/**
 * Attach monitoring.db on the main connection as schema `mon`.
 * Lets reporters JOIN api_keys (main) with mon.monitoring_snapshots without rewriting everything.
 */
export const attachMonitoringToMainDb = async (
  mainDb: Database<sqlite3.Database, sqlite3.Statement>,
): Promise<void> => {
  if (_attachedToMain) return;
  await initMonitoringDb();
  const escaped = DB_PATH.replace(/'/g, "''");
  try {
    await mainDb.exec(`ATTACH DATABASE '${escaped}' AS mon`);
    _attachedToMain = true;
    logger.info(`Attached monitoring DB as mon (${DB_PATH})`);
  } catch (error) {
    const msg = String((error as Error)?.message || error);
    if (/already in use|duplicate/i.test(msg)) {
      _attachedToMain = true;
      return;
    }
    throw error;
  }
};

const tableExists = async (
  database: Database<sqlite3.Database, sqlite3.Statement>,
  name: string,
): Promise<boolean> => {
  const row = await database.get(
    `SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?`,
    [name],
  );
  return Boolean(row);
};

/**
 * One-time copy of monitoring tables from main → monitoring.db, then drop main copies.
 * Safe to call on every boot (no-op after meta flag / empty main tables).
 */
export const migrateMonitoringFromMainDb = async (
  mainDb: Database<sqlite3.Database, sqlite3.Statement>,
): Promise<{ snapshots: number; fills: number; skipped: boolean }> => {
  await initMonitoringDb();
  const mdb = getMonitoringDb();

  const already = await mdb.get(
    `SELECT value FROM monitoring_meta WHERE key = 'migrated_from_main'`,
  ) as { value?: string } | undefined;
  if (already?.value) {
    return { snapshots: 0, fills: 0, skipped: true };
  }

  const hasMainSnaps = await tableExists(mainDb, 'monitoring_snapshots');
  const hasMainFills = await tableExists(mainDb, 'exchange_fill_events');
  if (!hasMainSnaps && !hasMainFills) {
    await mdb.run(
      `INSERT OR REPLACE INTO monitoring_meta (key, value, updated_at) VALUES ('migrated_from_main', ?, CURRENT_TIMESTAMP)`,
      [new Date().toISOString()],
    );
    return { snapshots: 0, fills: 0, skipped: true };
  }

  const nameById = new Map<number, string>();
  const keyRows = await mainDb.all(`SELECT id, name FROM api_keys`) as Array<{ id?: number; name?: string }>;
  for (const row of keyRows || []) {
    const id = Number(row.id);
    if (Number.isFinite(id)) nameById.set(id, String(row.name || ''));
  }

  let snapshots = 0;
  let fills = 0;

  if (hasMainSnaps) {
    const monCount = await mdb.get(`SELECT COUNT(*) AS c FROM monitoring_snapshots`) as { c?: number };
    const inMon = Number(monCount?.c || 0);
    const rows = await mainDb.all(`SELECT * FROM monitoring_snapshots`) as Array<Record<string, unknown>>;

    if (rows.length > 0 && inMon === 0) {
      await mdb.exec('BEGIN');
      try {
        for (const row of rows) {
          const apiKeyId = Number(row.api_key_id);
          await mdb.run(
            `INSERT INTO monitoring_snapshots (
              id, api_key_id, api_key_name, exchange, equity_usd, unrealized_pnl,
              margin_used_usd, margin_load_percent, effective_leverage, notional_usd,
              drawdown_percent, deposit_base_usd, pnl_net_usd, source, recorded_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id ?? null,
              apiKeyId,
              nameById.get(apiKeyId) || null,
              row.exchange ?? null,
              row.equity_usd ?? 0,
              row.unrealized_pnl ?? 0,
              row.margin_used_usd ?? 0,
              row.margin_load_percent ?? 0,
              row.effective_leverage ?? 0,
              row.notional_usd ?? 0,
              row.drawdown_percent ?? 0,
              row.deposit_base_usd ?? null,
              row.pnl_net_usd ?? null,
              row.source ?? 'live',
              row.recorded_at ?? null,
            ],
          );
        }
        await mdb.exec('COMMIT');
      } catch (error) {
        await mdb.exec('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const maxId = await mdb.get(`SELECT MAX(id) AS m FROM monitoring_snapshots`) as { m?: number };
      if (Number(maxId?.m || 0) > 0) {
        await mdb.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('monitoring_snapshots', ?)`,
          [Number(maxId.m)],
        ).catch(() => undefined);
      }
      snapshots = rows.length;
      logger.info(`Migrated ${snapshots} monitoring_snapshots → monitoring.db`);
    }

    await mainDb.exec(`DROP TABLE IF EXISTS monitoring_snapshots`);
  }

  if (hasMainFills) {
    const monCount = await mdb.get(`SELECT COUNT(*) AS c FROM exchange_fill_events`) as { c?: number };
    const inMon = Number(monCount?.c || 0);
    const rows = await mainDb.all(`SELECT * FROM exchange_fill_events`) as Array<Record<string, unknown>>;

    if (rows.length > 0 && inMon === 0) {
      await mdb.exec('BEGIN');
      try {
        for (const row of rows) {
          const apiKeyId = Number(row.api_key_id);
          await mdb.run(
            `INSERT INTO exchange_fill_events (
              id, api_key_id, api_key_name, trade_type, side, source_trade_id, source_order_id,
              source_symbol, actual_price, position_size, actual_fee, realized_pnl, is_maker,
              actual_time, event_origin, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              row.id ?? null,
              apiKeyId,
              nameById.get(apiKeyId) || null,
              row.trade_type,
              row.side,
              row.source_trade_id,
              row.source_order_id ?? null,
              row.source_symbol ?? null,
              row.actual_price,
              row.position_size,
              row.actual_fee ?? 0,
              row.realized_pnl ?? 0,
              row.is_maker ?? 0,
              row.actual_time,
              row.event_origin ?? 'exchange_backfill',
              row.created_at ?? null,
            ],
          );
        }
        await mdb.exec('COMMIT');
      } catch (error) {
        await mdb.exec('ROLLBACK').catch(() => undefined);
        throw error;
      }
      const maxId = await mdb.get(`SELECT MAX(id) AS m FROM exchange_fill_events`) as { m?: number };
      if (Number(maxId?.m || 0) > 0) {
        await mdb.run(
          `INSERT OR REPLACE INTO sqlite_sequence (name, seq) VALUES ('exchange_fill_events', ?)`,
          [Number(maxId.m)],
        ).catch(() => undefined);
      }
      fills = rows.length;
      logger.info(`Migrated ${fills} exchange_fill_events → monitoring.db`);
    }

    await mainDb.exec(`DROP TABLE IF EXISTS exchange_fill_events`);
  }

  await mdb.run(
    `INSERT OR REPLACE INTO monitoring_meta (key, value, updated_at) VALUES ('migrated_from_main', ?, CURRENT_TIMESTAMP)`,
    [new Date().toISOString()],
  );

  await attachMonitoringToMainDb(mainDb);
  return { snapshots, fills, skipped: false };
};

export const deleteMonitoringDataForApiKey = async (apiKeyId: number): Promise<void> => {
  await initMonitoringDb();
  const mdb = getMonitoringDb();
  await mdb.run(`DELETE FROM monitoring_snapshots WHERE api_key_id = ?`, [apiKeyId]);
  await mdb.run(`DELETE FROM exchange_fill_events WHERE api_key_id = ?`, [apiKeyId]);
};

/** Delete monitoring rows older than N days (snapshots by recorded_at, fills by actual_time ms). */
export const purgeMonitoringDataOlderThanDays = async (
  days: number,
): Promise<{ snapshots: number; fills: number }> => {
  await initMonitoringDb();
  const mdb = getMonitoringDb();
  const safeDays = Math.max(1, Math.floor(days));
  const cutoffMs = Date.now() - safeDays * 86400000;

  const snapResult = await mdb.run(
    `DELETE FROM monitoring_snapshots
     WHERE datetime(recorded_at) < datetime('now', ?)`,
    [`-${safeDays} days`],
  );
  const fillResult = await mdb.run(
    `DELETE FROM exchange_fill_events WHERE actual_time < ?`,
    [cutoffMs],
  );

  return {
    snapshots: Number((snapResult as { changes?: number })?.changes || 0),
    fills: Number((fillResult as { changes?: number })?.changes || 0),
  };
};

const RETENTION_PURGE_META_KEY = 'retention_purge_30d_20260823';

/** One-time (meta-guarded) purge of pre-stabilization monitoring history. */
export const ensureMonitoringRetentionPurge = async (): Promise<void> => {
  await initMonitoringDb();
  const mdb = getMonitoringDb();
  const row = await mdb.get(
    `SELECT value FROM monitoring_meta WHERE key = ?`,
    [RETENTION_PURGE_META_KEY],
  ) as { value?: string } | undefined;
  if (row?.value) {
    return;
  }

  const retentionDays = Math.max(
    1,
    Math.floor(Number(process.env.MONITORING_RETENTION_DAYS || 30)),
  );
  const result = await purgeMonitoringDataOlderThanDays(retentionDays);
  await mdb.run(`VACUUM`);
  await mdb.run(
    `INSERT OR REPLACE INTO monitoring_meta (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP)`,
    [RETENTION_PURGE_META_KEY, JSON.stringify({ retentionDays, ...result, at: new Date().toISOString() })],
  );
  logger.info(
    `[monitoring] Retention purge (>${retentionDays}d): snapshots=${result.snapshots} fills=${result.fills}`,
  );
};

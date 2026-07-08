#!/usr/bin/env node
/**
 * Diagnose BingX algofund clients with 0 exchange_fill.
 * Prints hedge flags, position mode clues, last strategy actions, sample order errors.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);

const database = require(path.join(backendRoot, 'dist/utils/database.js'));
const {
  ensureExchangeClientInitialized,
  getPositions,
  getBalances,
} = require(path.join(backendRoot, 'dist/bot/exchange.js'));

const KEYS = (process.env.KEYS || 'HDB_15,HDB_18,tenant-69195-bingxalgo-api')
  .split(',').map((s) => s.trim()).filter(Boolean);
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'bingx_fills_diag_jul2026.json');

await database.initDB();
const { db } = database;

const report = { generatedAt: new Date().toISOString(), clients: [] };

for (const apiKey of KEYS) {
  const row = {
    apiKey,
    profile: null,
    flags: {},
    activeLegs: 0,
    fills24h: 0,
    lastMomAction: null,
    balance: null,
    positions: null,
    hedgeProbe: null,
    errors: [],
  };

  try {
    row.profile = await db.get(
      `SELECT published_system_name, actual_enabled, execution_api_key_name
       FROM algofund_profiles WHERE execution_api_key_name = ?`,
      [apiKey],
    );
    const ak = await db.get(`SELECT id, exchange, name FROM api_keys WHERE name = ?`, [apiKey]);
    row.exchange = ak?.exchange;

    const flagRows = await db.all(
      `SELECT key, value FROM app_runtime_flags
       WHERE key LIKE ? OR key LIKE '%bingx%' OR key LIKE '%hedge%'
       ORDER BY key`,
      [`%${apiKey}%`],
    );
    for (const f of flagRows || []) row.flags[f.key] = String(f.value || '').slice(0, 200);

    // Also scan exchange.bingx_hedge_api_keys style flags
    const hedgeFlag = await db.get(
      `SELECT key, value FROM app_runtime_flags WHERE key IN (
         'exchange.bingx_hedge_api_keys','exchange.bingx_one_way_api_keys','bingx.hedge.confirmed'
       )`,
    );
    // get all relevant
    const allHedge = await db.all(
      `SELECT key, substr(value,1,500) value FROM app_runtime_flags
       WHERE key LIKE 'exchange.bingx%' OR key LIKE '%hedge%'`,
    );
    row.hedgeFlags = allHedge;

    const stats = await db.get(
      `SELECT
         SUM(CASE WHEN s.is_active=1 AND s.auto_update=1 THEN 1 ELSE 0 END) active_legs,
         (SELECT COUNT(*) FROM live_trade_events lte JOIN strategies s2 ON s2.id=lte.strategy_id
          WHERE s2.api_key_id = a.id AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
            AND lte.actual_time >= (strftime('%s','now')-86400)*1000) fills24h
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ?`,
      [apiKey],
    );
    row.activeLegs = Number(stats?.active_legs || 0);
    row.fills24h = Number(stats?.fills24h || 0);

    row.lastMomAction = await db.get(
      `SELECT s.id, s.base_symbol, s.last_action, s.last_signal, s.last_error, s.updated_at
       FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
       WHERE a.name=? AND s.strategy_type='momentum_scalp_tv' AND s.is_active=1
       ORDER BY s.updated_at DESC LIMIT 1`,
      [apiKey],
    );

    row.errorsSample = await db.all(
      `SELECT s.id, s.base_symbol, s.last_action, s.last_error
       FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
       WHERE a.name=? AND s.is_active=1
         AND (COALESCE(s.last_error,'') != '' OR s.last_action LIKE '%fail%' OR s.last_action LIKE '%denied%')
       LIMIT 10`,
      [apiKey],
    );

    await ensureExchangeClientInitialized(apiKey);
    try {
      const bal = await getBalances(apiKey);
      row.balance = Array.isArray(bal)
        ? bal.filter((b) => Number(b.free || b.total || 0) > 0).slice(0, 8)
        : bal;
    } catch (err) {
      row.errors.push(`balance: ${err.message}`);
    }
    try {
      const pos = await getPositions(apiKey);
      const open = (Array.isArray(pos) ? pos : []).filter((p) => Math.abs(Number(p.size || 0)) > 0);
      row.positions = { openCount: open.length, sample: open.slice(0, 5) };
    } catch (err) {
      row.errors.push(`positions: ${err.message}`);
    }
  } catch (err) {
    row.errors.push(err.message);
  }

  report.clients.push(row);
  console.log(
    `${apiKey}: active=${row.activeLegs} fills24h=${row.fills24h} ` +
    `bal_err=${row.errors.filter((e) => e.startsWith('balance')).length} ` +
    `pos=${row.positions?.openCount ?? 'n/a'}`,
  );
}

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(`Wrote ${OUT_JSON}`);

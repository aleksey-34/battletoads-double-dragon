#!/usr/bin/env node
/**
 * Hard-stop legacy ZZ (and optional DD/stat_arb) on BTDD_D1 master key.
 * Keeps competition algofund cards untouched.
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
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const { closeStrategyPositions } = require(path.join(backendRoot, 'dist/bot/strategy.js'));

const DB_FILE = process.env.DB_FILE || path.join(backendRoot, 'database.db');
const API_KEY = process.env.API_KEY || 'BTDD_D1';
const DRY_RUN = process.env.DRY_RUN === '1';
const TYPES = (process.env.TYPES || 'zz_breakout').split(',').map((s) => s.trim()).filter(Boolean);
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'hard_stop_btdd_d1_legacy_jul2026.json');

await database.initDB();
const { db } = database;

const placeholders = TYPES.map(() => '?').join(',');
const rows = await db.all(
  `SELECT s.id, s.name, s.strategy_type, s.state, s.is_active, s.auto_update, a.name AS api_key
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   WHERE a.name = ?
     AND s.strategy_type IN (${placeholders})
     AND (s.is_active = 1 OR s.auto_update = 1 OR s.state != 'flat')
   ORDER BY s.strategy_type, s.id`,
  [API_KEY, ...TYPES],
);

const report = {
  generatedAt: new Date().toISOString(),
  dryRun: DRY_RUN,
  apiKey: API_KEY,
  types: TYPES,
  targets: rows.length,
  closed: [],
  disabled: [],
  errors: [],
};

console.log(`BTDD_D1 hard-stop types=${TYPES.join(',')} targets=${rows.length} dryRun=${DRY_RUN}`);

if (!DRY_RUN && rows.length) {
  try {
    await ensureExchangeClientInitialized(API_KEY);
  } catch (err) {
    report.errors.push({ phase: 'init', error: err.message });
  }
}

for (const row of rows) {
  const id = Number(row.id);
  try {
    if (!DRY_RUN) {
      if (row.state !== 'flat') {
        await closeStrategyPositions(API_KEY, id);
        report.closed.push({ id, type: row.strategy_type, state: row.state });
      }
      await db.run(
        `UPDATE strategies
         SET is_active = 0, auto_update = 0, state = 'flat',
             entry_ratio = NULL, tp_anchor_ratio = NULL,
             last_action = 'hard_stop_btdd_d1_legacy_jul2026',
             last_error = NULL, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [id],
      );
      await db.run(`UPDATE trading_system_members SET is_enabled = 0 WHERE strategy_id = ?`, [id]);
    }
    report.disabled.push({ id, type: row.strategy_type, name: row.name, wasActive: row.is_active });
    console.log(`OK #${id} ${row.strategy_type}`);
  } catch (err) {
    report.errors.push({ id, error: err.message });
    console.error(`ERR #${id}: ${err.message}`);
  }
}

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(`Wrote ${OUT_JSON}`);
console.log(`disabled=${report.disabled.length} closed=${report.closed.length} errors=${report.errors.length}`);

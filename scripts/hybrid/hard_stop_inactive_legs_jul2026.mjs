#!/usr/bin/env node
/**
 * P0 hard-stop: disable legacy/disabled legs on live algofund clients,
 * close exchange exposure where needed.
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
const DRY_RUN = process.env.DRY_RUN === '1';
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'hard_stop_inactive_legs_jul2026.json');

const CT_BAD_SIDS = ['239259', '239282', '242969', '242974'];
const sidClause = CT_BAD_SIDS.map((s) => `s.name LIKE '%::SID${s}'`).join(' OR ');

await database.initDB();
const { db } = database;

const report = {
  generatedAt: new Date().toISOString(),
  dryRun: DRY_RUN,
  bulkAutoOff: 0,
  zzDisabled: 0,
  ctBadDisabled: 0,
  closed: [],
  errors: [],
};

if (!DRY_RUN) {
  const bulk = await db.run(
    `UPDATE strategies SET auto_update = 0,
            last_action = COALESCE(last_action, 'hard_stop_auto_off_inactive'),
            updated_at = CURRENT_TIMESTAMP
     WHERE is_active = 0 AND auto_update = 1
       AND api_key_id IN (
         SELECT a.id FROM api_keys a
         JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name
         WHERE ap.actual_enabled = 1
       )`,
  );
  report.bulkAutoOff = Number(bulk?.changes || 0);
} else {
  const row = await db.get(
    `SELECT COUNT(*) AS n FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
     WHERE s.is_active = 0 AND s.auto_update = 1`,
  );
  report.bulkAutoOff = Number(row?.n || 0);
}

const toDisable = await db.all(
  `SELECT s.id, s.name, s.strategy_type, s.state, a.name AS api_key
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
   WHERE s.is_active = 1
     AND (
       s.strategy_type = 'zz_breakout'
       OR (s.strategy_type = 'CT_Fractal' AND (${sidClause}))
     )
   ORDER BY a.name, s.id`,
);

const needClose = await db.all(
  `SELECT s.id, s.name, s.strategy_type, s.state, a.name AS api_key
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
   WHERE s.state != 'flat'
     AND (s.is_active = 0 OR s.strategy_type = 'zz_breakout' OR (s.strategy_type = 'CT_Fractal' AND (${sidClause})))
   ORDER BY a.name, s.id`,
);

const apiKeys = new Set([
  ...toDisable.map((r) => r.api_key),
  ...needClose.map((r) => r.api_key),
]);

console.log(`bulkAutoOff=${report.bulkAutoOff} disable=${toDisable.length} close=${needClose.length} dryRun=${DRY_RUN}`);

if (!DRY_RUN) {
  for (const apiKey of apiKeys) {
    try {
      await ensureExchangeClientInitialized(apiKey);
    } catch (err) {
      report.errors.push({ apiKey, phase: 'init', error: err.message });
    }
  }

  for (const row of needClose) {
    try {
      await closeStrategyPositions(row.api_key, Number(row.id));
      report.closed.push({ id: row.id, apiKey: row.api_key, type: row.strategy_type, state: row.state });
    } catch (err) {
      report.errors.push({ id: row.id, apiKey: row.api_key, phase: 'close', error: err.message });
    }
  }

  if (toDisable.length) {
    const ids = toDisable.map((r) => Number(r.id));
    const ph = ids.map(() => '?').join(',');
    const zzN = toDisable.filter((r) => r.strategy_type === 'zz_breakout').length;
    const ctN = toDisable.length - zzN;
    await db.run(
      `UPDATE strategies SET is_active = 0, auto_update = 0, state = 'flat',
              entry_ratio = NULL, tp_anchor_ratio = NULL,
              last_action = 'hard_stop_inactive_jul2026',
              updated_at = CURRENT_TIMESTAMP
       WHERE id IN (${ph})`,
      ids,
    );
    await db.run(
      `UPDATE trading_system_members SET is_enabled = 0 WHERE strategy_id IN (${ph})`,
      ids,
    );
    report.zzDisabled = zzN;
    report.ctBadDisabled = ctN;
  }
} else {
  report.zzDisabled = toDisable.filter((r) => r.strategy_type === 'zz_breakout').length;
  report.ctBadDisabled = toDisable.filter((r) => r.strategy_type === 'CT_Fractal').length;
  report.wouldClose = needClose.length;
}

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));

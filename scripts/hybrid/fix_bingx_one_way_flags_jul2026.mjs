#!/usr/bin/env node
/**
 * Move misclassified BingX algofund keys from hedge → one-way flags.
 * Usage: BTDD_DB=/path/to/database.db node scripts/hybrid/fix_bingx_one_way_flags_jul2026.mjs
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BTDD_DB || path.resolve(__dirname, '../../backend/database.db');

const TO_ONE_WAY = [
  'HDB_15',
  'HDB_18',
  'tenant-69195-bingxalgo-api',
];
const ONE_WAY_KEY = 'exchange.bingx_one_way_api_keys';
const HEDGE_KEY = 'exchange.bingx_hedge_api_keys';

const readJsonList = (key) => {
  try {
    const out = execFileSync('sqlite3', [dbPath, `SELECT value FROM app_runtime_flags WHERE key='${key}';`], { encoding: 'utf8' }).trim();
    const parsed = JSON.parse(out || '[]');
    return Array.isArray(parsed) ? parsed.map((v) => String(v).trim()).filter(Boolean) : [];
  } catch {
    return [];
  }
};

const writeJsonList = (key, values) => {
  const payload = JSON.stringify([...new Set(values)].sort()).replace(/'/g, "''");
  execFileSync('sqlite3', [dbPath, `
INSERT INTO app_runtime_flags (key, value, updated_at)
VALUES ('${key}', '${payload}', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
`]);
};

let oneWay = readJsonList(ONE_WAY_KEY);
let hedge = readJsonList(HEDGE_KEY);

for (const name of TO_ONE_WAY) {
  hedge = hedge.filter((v) => v !== name);
  if (!oneWay.includes(name)) oneWay.push(name);
}

writeJsonList(ONE_WAY_KEY, oneWay);
writeJsonList(HEDGE_KEY, hedge);

// Clear stale positionSide errors so runtime retries on next signal.
const namesSql = TO_ONE_WAY.map((n) => `'${n.replace(/'/g, "''")}'`).join(',');
execFileSync('sqlite3', [dbPath, `
UPDATE strategies SET last_error = NULL, last_action = 'bingx_one_way_flag_reset'
WHERE api_key_id IN (SELECT id FROM api_keys WHERE name IN (${namesSql}))
  AND (
    COALESCE(last_error, '') LIKE '%109400%'
    OR LOWER(COALESCE(last_error, '')) LIKE '%one-way mode%'
    OR LOWER(COALESCE(last_error, '')) LIKE '%positionside%'
  );
`]);

console.log(JSON.stringify({ ok: true, one_way: oneWay.sort(), hedge: hedge.sort() }, null, 2));

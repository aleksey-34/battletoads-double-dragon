#!/usr/bin/env node
/** Open exchange positions on disabled / off algofund tenants */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(root, 'dist/utils/database.js'));
const exchange = require(path.join(root, 'dist/bot/exchange.js'));
await database.initDB();
const { db } = database;
const { getPositions, ensureExchangeClientInitialized } = exchange;

const normalizeKey = (raw) => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

const rows = await db.all(`
  SELECT t.slug,
         ap.requested_enabled,
         ap.actual_enabled,
         COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name) AS api_key
  FROM algofund_profiles ap
  JOIN tenants t ON t.id = ap.tenant_id
  WHERE ap.requested_enabled = 0 OR ap.actual_enabled = 0
  ORDER BY t.slug
`);

console.log('=== DISABLED ALGOFUND — exchange positions ===\n');
let withPos = 0;

for (const row of rows) {
  const apiKey = String(row.api_key || '').trim();
  if (!apiKey) {
    console.log(`${row.slug}: no api_key`);
    continue;
  }
  try {
    await ensureExchangeClientInitialized(apiKey);
    const positions = await getPositions(apiKey);
    const open = (positions || []).filter((p) => Math.abs(Number(p?.size || 0)) > 0);
    if (open.length === 0) continue;
    withPos += 1;
    const syms = open.map((p) => `${normalizeKey(p.symbol)}(${p.size})`).join(', ');
    console.log(`*** ${row.slug} [req=${row.requested_enabled} act=${row.actual_enabled}] key=${apiKey}`);
    console.log(`    ${open.length} positions: ${syms}`);
  } catch (error) {
    console.log(`ERR ${row.slug} (${apiKey}): ${error?.message || error}`);
  }
}

console.log(`\nDisabled tenants with open exchange positions: ${withPos}`);

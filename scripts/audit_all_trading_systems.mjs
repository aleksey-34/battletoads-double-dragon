#!/usr/bin/env node
/**
 * Audit every active trading_system (not only enabled algofund tenants).
 * Usage: cd backend && node ../scripts/audit_all_trading_systems.mjs
 */
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

const systems = await db.all(`
  SELECT ts.id, ts.name, ts.max_open_positions AS mop, ak.name AS api_key
  FROM trading_systems ts
  JOIN api_keys ak ON ak.id = ts.api_key_id
  WHERE ts.is_active = 1
  ORDER BY ak.name, ts.name
`);

console.log('=== ALL ACTIVE TRADING SYSTEMS ===\n');
const issues = [];
const apiCache = new Map();

const getExchangeKeys = async (apiKey) => {
  if (apiCache.has(apiKey)) return apiCache.get(apiKey);
  await ensureExchangeClientInitialized(apiKey);
  const positions = await getPositions(apiKey);
  const keys = [
    ...new Set(
      (positions || [])
        .filter((p) => Math.abs(Number(p?.size || 0)) > 0)
        .map((p) => normalizeKey(p.symbol))
        .filter(Boolean),
    ),
  ];
  apiCache.set(apiKey, keys);
  return keys;
};

for (const row of systems) {
  const mop = Number(row.mop || 0);
  const members = await db.all(
    `SELECT s.base_symbol, s.state, tsm.is_enabled, s.is_active
     FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE tsm.system_id = ?
       AND COALESCE(s.strategy_type,'') NOT IN ('dca','dca_futures')`,
    [row.id],
  );

  const memberKeys = new Set(
    members
      .filter((m) => m.is_enabled === 1 && m.is_active === 1)
      .map((m) => normalizeKey(m.base_symbol))
      .filter(Boolean),
  );
  const owned = new Set(
    members
      .filter((m) => m.is_enabled === 1 && m.is_active === 1 && m.state !== 'flat')
      .map((m) => normalizeKey(m.base_symbol))
      .filter(Boolean),
  );

  let exchKeys = [];
  try {
    exchKeys = await getExchangeKeys(row.api_key);
  } catch (error) {
    console.log(`ERR ${row.name} (${row.api_key}): ${error?.message || error}`);
    continue;
  }

  const orphans = exchKeys.filter((s) => !owned.has(s));
  const ghosts = [...owned].filter((s) => !exchKeys.includes(s));
  const unmanaged = exchKeys.filter((s) => !memberKeys.has(s));

  const problems = [];
  if (owned.size > mop) problems.push(`db>${mop}(${owned.size})`);
  if (exchKeys.length > mop) problems.push(`exch>${mop}(${exchKeys.length})`);
  if (orphans.length) problems.push(`orphan:${orphans.join(',')}`);
  if (ghosts.length) problems.push(`ghost-db:${ghosts.slice(0, 8).join(',')}${ghosts.length > 8 ? '…' : ''}`);
  if (unmanaged.length) problems.push(`unmanaged:${unmanaged.join(',')}`);

  const flag = problems.length > 0;
  if (flag) {
    issues.push({ ...row, mop, dbN: owned.size, exchN: exchKeys.length, problems, orphans, ghosts, unmanaged });
  }

  if (flag || owned.size > 0 || exchKeys.length > 0) {
    console.log(
      `${flag ? '***' : '   '} ${String(row.name).slice(0, 44).padEnd(44)} ${String(row.api_key).slice(0, 26).padEnd(26)} OP${String(mop).padStart(2)} db${String(owned.size).padStart(2)} ex${String(exchKeys.length).padStart(2)}  ${problems.join(' | ') || 'ok'}`,
    );
  }
}

console.log(`\nActive systems scanned: ${systems.length}`);
console.log(`With open state or issues: ${issues.length}`);

if (issues.length) {
  console.log('\n--- Issues detail ---');
  for (const i of issues) {
    console.log(`\n${i.name} | ${i.api_key}`);
    console.log(`  ${i.problems.join(' ; ')}`);
  }
}

process.exit(issues.length > 0 ? 1 : 0);

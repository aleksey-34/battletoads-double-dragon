#!/usr/bin/env node
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

const masters = await db.all(`
  SELECT ts.id, ts.name, ts.max_open_positions AS mop, ak.name AS api_key
  FROM trading_systems ts
  JOIN api_keys ak ON ak.id = ts.api_key_id
  WHERE ts.is_active = 1 AND ts.name LIKE 'ALGOFUND_MASTER%'
  ORDER BY ts.name
`);

console.log('=== ALGOFUND_MASTER (cloud) systems ===\n');
let issues = 0;

for (const row of masters) {
  const members = await db.all(
    `SELECT s.base_symbol, s.state, tsm.is_enabled, s.is_active
     FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE tsm.system_id = ?
       AND COALESCE(s.strategy_type,'') NOT IN ('dca','dca_futures')`,
    [row.id],
  );
  const owned = members
    .filter((m) => m.is_enabled === 1 && m.is_active === 1 && m.state !== 'flat')
    .map((m) => normalizeKey(m.base_symbol));
  const memberKeys = new Set(
    members
      .filter((m) => m.is_enabled === 1 && m.is_active === 1)
      .map((m) => normalizeKey(m.base_symbol))
      .filter(Boolean),
  );

  let ex = [];
  try {
    await ensureExchangeClientInitialized(row.api_key);
    const pos = await getPositions(row.api_key);
    ex = (pos || [])
      .filter((p) => Math.abs(Number(p?.size || 0)) > 0)
      .map((p) => normalizeKey(p.symbol));
  } catch (e) {
    console.log(`ERR ${row.name}: ${e.message}`);
    continue;
  }

  const exSet = [...new Set(ex)];
  const ownedSet = [...new Set(owned)];
  const orphans = exSet.filter((s) => !ownedSet.includes(s));
  const ghosts = ownedSet.filter((s) => !exSet.includes(s));
  const mop = Number(row.mop || 0);

  const problems = [];
  if (ownedSet.length > mop) problems.push(`db>${mop}`);
  if (exSet.length > mop) problems.push(`exch>${mop}`);
  if (orphans.length) problems.push(`orphan:${orphans.join(',')}`);
  if (ghosts.length) problems.push(`ghost:${ghosts.length}`);

  const flag = problems.length > 0;
  if (flag) issues += 1;
  if (flag || ownedSet.length > 0 || exSet.length > 0) {
    console.log(
      `${flag ? '***' : '   '} ${row.name.slice(0, 56).padEnd(56)} OP${mop} db${ownedSet.length} ex${exSet.length}  ${problems.join(' | ') || 'ok'}`,
    );
  }
}

console.log(`\nMaster systems with issues: ${issues}`);

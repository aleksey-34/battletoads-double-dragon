#!/usr/bin/env node
/**
 * Full live position audit per enabled algofund client:
 * - exchange orphans (on WEEX/BingX but no non-flat TS owner)
 * - exchange OP overflow
 * - DB OP overflow (non-flat count > max_open_positions)
 * - DB ghost (non-flat in DB but zero size on exchange)
 * - unmanaged (on exchange but symbol not in any enabled TS member slot)
 *
 * Usage on VPS: cd /opt/battletoads-double-dragon/backend && node ../scripts/audit_live_exchange_positions.mjs
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

const rows = await db.all(`
  SELECT t.slug,
         ts.id AS ts_id,
         ts.max_open_positions AS mop,
         ts.name AS ts_name,
         COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name) AS api_key
  FROM algofund_profiles ap
  JOIN tenants t ON t.id = ap.tenant_id
  JOIN api_keys ak ON ak.name = COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name)
  JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = 'ALGOFUND::' || t.slug AND ts.is_active = 1
  WHERE ap.requested_enabled = 1 AND ap.actual_enabled = 1
  ORDER BY t.slug
`);

console.log('=== ALGOFUND LIVE POSITION AUDIT ===\n');
console.log(
  'slug                          OP  db exch | issues',
);
console.log(
  '                              (db=non-flat strategies, exch=unique symbols on exchange)',
);

const issues = [];
let okCount = 0;
let errCount = 0;

for (const row of rows) {
  const mop = Number(row.mop || 0);

  const members = await db.all(
    `SELECT s.id AS sid, s.base_symbol, s.state, s.is_active AS s_active, tsm.is_enabled AS m_enabled
     FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE tsm.system_id = ?
       AND COALESCE(s.strategy_type,'') NOT IN ('dca','dca_futures')`,
    [row.ts_id],
  );

  const enabledMemberKeys = new Set(
    members
      .filter((m) => m.m_enabled === 1 && m.s_active === 1)
      .map((m) => normalizeKey(m.base_symbol))
      .filter(Boolean),
  );

  const dbOpen = members.filter(
    (m) => m.m_enabled === 1 && m.s_active === 1 && m.state !== 'flat',
  );
  const owned = new Set(dbOpen.map((m) => normalizeKey(m.base_symbol)).filter(Boolean));

  let exchangeSymbols = [];
  let exchangeByKey = new Map();
  try {
    await ensureExchangeClientInitialized(row.api_key);
    const positions = await getPositions(row.api_key);
    for (const p of positions || []) {
      if (Math.abs(Number(p?.size || 0)) <= 0) continue;
      const sym = String(p.symbol || '').trim();
      const key = normalizeKey(sym);
      if (!key) continue;
      exchangeSymbols.push(sym);
      exchangeByKey.set(key, {
        symbol: sym,
        size: Number(p.size),
        side: Number(p.size) > 0 ? 'long' : 'short',
      });
    }
  } catch (error) {
    errCount += 1;
    console.log(`ERR ${String(row.slug).padEnd(28)}     — ${error?.message || error}`);
    issues.push({ slug: row.slug, api_key: row.api_key, error: String(error?.message || error) });
    continue;
  }

  const exchangeKeys = [...exchangeByKey.keys()];
  const exchangeCount = exchangeKeys.length;

  const orphans = exchangeKeys.filter((sym) => !owned.has(sym));
  const unmanaged = exchangeKeys.filter((sym) => !enabledMemberKeys.has(sym));
  const ghosts = [...owned].filter((sym) => !exchangeByKey.has(sym));

  const problemParts = [];
  if (dbOpen.length > mop) problemParts.push(`db>${mop}(${dbOpen.length})`);
  if (exchangeCount > mop) problemParts.push(`exch>${mop}`);
  if (orphans.length) problemParts.push(`orphan:${orphans.join(',')}`);
  if (unmanaged.length && unmanaged.some((s) => !orphans.includes(s))) {
    const extra = unmanaged.filter((s) => orphans.includes(s));
    if (extra.length !== unmanaged.length) {
      problemParts.push(`unmanaged:${unmanaged.join(',')}`);
    }
  }
  if (ghosts.length) problemParts.push(`ghost-db:${ghosts.join(',')}`);

  const flag = problemParts.length > 0;
  if (!flag) okCount += 1;

  console.log(
    `${flag ? '***' : '   '} ${String(row.slug).padEnd(28)} ${String(mop).padStart(2)} ${String(dbOpen.length).padStart(3)} ${String(exchangeCount).padStart(4)}  ${problemParts.join(' | ') || 'ok'}`,
  );

  if (flag) {
    issues.push({
      slug: row.slug,
      api_key: row.api_key,
      ts_name: row.ts_name,
      mop,
      dbOpen: dbOpen.length,
      exchangeCount,
      orphans,
      ghosts,
      unmanaged,
      dbSymbols: [...owned],
      exchangeSymbols: exchangeKeys,
    });
  }
}

console.log(`\n--- Summary ---`);
console.log(`Clients checked: ${rows.length}`);
console.log(`OK: ${okCount}`);
console.log(`Issues: ${issues.length}`);
console.log(`API errors: ${errCount}`);

if (issues.length) {
  console.log('\n--- Detail (issues only) ---');
  for (const i of issues) {
    if (i.error) continue;
    console.log(`\n${i.slug} (${i.api_key}) TS=${i.ts_name}`);
    console.log(`  OP=${i.mop}  db_non_flat=${i.dbOpen}  exchange=${i.exchangeCount}`);
    if (i.orphans?.length) console.log(`  Orphan on exchange (no TS owner): ${i.orphans.join(', ')}`);
    if (i.ghosts?.length) console.log(`  Ghost in DB (flat on exchange): ${i.ghosts.join(', ')}`);
    if (i.unmanaged?.length) console.log(`  Not in enabled members: ${i.unmanaged.join(', ')}`);
    if (i.dbOpen > i.mop) console.log(`  WARNING: DB exceeds OP limit`);
  }
}

process.exit(issues.length > 0 ? 1 : 0);

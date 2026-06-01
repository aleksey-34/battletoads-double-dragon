#!/usr/bin/env node
/**
 * Compare exchange open positions vs DB non-flat strategies per algofund TS.
 * Usage on VPS: cd /opt/battletoads-double-dragon/backend && node ../scripts/audit_live_exchange_positions.mjs
 */
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const { db } = await import(path.join(root, 'dist/utils/database.js'));
const { getPositions, ensureExchangeClientInitialized } = await import(path.join(root, 'dist/bot/exchange.js'));

const normalizeKey = (raw) => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

const rows = await db.all(`
  SELECT t.slug,
         ts.id AS ts_id,
         ts.max_open_positions AS mop,
         COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name) AS api_key
  FROM algofund_profiles ap
  JOIN tenants t ON t.id = ap.tenant_id
  JOIN api_keys ak ON ak.name = COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name)
  JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = 'ALGOFUND::' || t.slug AND ts.is_active = 1
  WHERE ap.requested_enabled = 1 AND ap.actual_enabled = 1
  ORDER BY t.slug
`);

console.log('slug                          OP  db exch  notes');
const issues = [];

for (const row of rows) {
  const dbOpen = await db.all(
    `SELECT s.base_symbol, s.state FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE tsm.system_id = ? AND tsm.is_enabled = 1 AND s.is_active = 1
       AND s.state != 'flat' AND COALESCE(s.strategy_type,'') NOT IN ('dca','dca_futures')`,
    [row.ts_id],
  );
  const owned = new Set(dbOpen.map((s) => normalizeKey(s.base_symbol)).filter(Boolean));
  let exchangeSymbols = [];
  let exchangeCount = -1;
  try {
    await ensureExchangeClientInitialized(row.api_key);
    const positions = await getPositions(row.api_key);
    exchangeSymbols = (positions || [])
      .filter((p) => Math.abs(Number(p?.size || 0)) > 0)
      .map((p) => String(p.symbol || '').trim());
    exchangeCount = new Set(exchangeSymbols.map(normalizeKey).filter(Boolean)).size;
  } catch (error) {
    console.log(`ERR ${row.slug}: ${error?.message || error}`);
    continue;
  }

  const exchangeKeys = [...new Set(exchangeSymbols.map(normalizeKey).filter(Boolean))];
  const orphans = exchangeKeys.filter((sym) => !owned.has(sym));
  const mop = Number(row.mop || 0);
  const flag = exchangeCount > mop || orphans.length > 0;
  const notes = [
    orphans.length ? `orphan:${orphans.join(',')}` : '',
    exchangeCount > mop ? `exch>${mop}` : '',
  ].filter(Boolean).join(' ');
  console.log(
    `${flag ? '***' : '   '} ${String(row.slug).padEnd(28)} ${String(mop).padStart(2)} ${String(dbOpen.length).padStart(3)} ${String(exchangeCount).padStart(4)}  ${notes}`,
  );
  if (flag) issues.push({ slug: row.slug, mop, dbOpen: dbOpen.length, exchangeCount, orphans });
}

console.log(`\nMismatch clients: ${issues.length}`);
process.exit(0);

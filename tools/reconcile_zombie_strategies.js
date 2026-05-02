#!/usr/bin/env node
/**
 * Reconcile zombie duplicate strategies.
 *
 * Problem: many api_keys have N strategies all targeting the same base_symbol.
 * Only ONE has state in (long/short); siblings are flat OR (rarely) also non-flat
 * after a desync. The exchange position is shared — closing it on every exit
 * thrashes siblings via closeAllForSymbol.
 *
 * This script:
 *  1) Lists per (api_key, base_symbol) groups with multiple active strategies.
 *  2) Fetches actual exchange positions for each api_key.
 *  3) Resolves the "owner" (the strategy in long/short matching exchange side, oldest wins).
 *  4) Marks all OTHER non-flat strategies on the same (api_key, symbol) as state='flat'
 *     WITHOUT closing the exchange position. Their last_action becomes 'reconcile_marked_flat'.
 *
 * Usage:
 *   node tools/reconcile_zombie_strategies.js              # dry-run
 *   node tools/reconcile_zombie_strategies.js --apply      # actually update DB
 *   node tools/reconcile_zombie_strategies.js --api-key=X  # only one api_key
 */
const path = require('path');
const fs = require('fs');

const DB_PATH = path.resolve(__dirname, '..', 'backend', 'database.db');
if (!fs.existsSync(DB_PATH)) {
  console.error(`DB not found at ${DB_PATH}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const onlyApiArg = args.find((a) => a.startsWith('--api-key='));
const ONLY_API_KEY = onlyApiArg ? onlyApiArg.split('=')[1] : null;

(async () => {
  const sqlite3 = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'sqlite'));

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA busy_timeout = 30000;');

  // Try to import getPositions from the running backend; if not available,
  // we just resolve "owner" by oldest open strategy in DB.
  let getPositions = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exch = require(path.resolve(__dirname, '..', 'backend', 'dist', 'bot', 'exchange.js'));
    getPositions = exch.getPositions;
    console.log('[info] using live getPositions() from backend/dist/bot/exchange.js');
  } catch (e) {
    console.log('[warn] backend dist not loadable; skipping live exchange check, using DB-only owner resolution');
  }

  const apiKeyFilter = ONLY_API_KEY ? `AND a.name = '${ONLY_API_KEY.replace(/'/g, "''")}'` : '';

  const groups = await db.all(`
    SELECT s.api_key_id, a.name AS api_key, s.base_symbol,
           COUNT(*) AS total,
           SUM(CASE WHEN s.state='long' THEN 1 ELSE 0 END) AS db_long,
           SUM(CASE WHEN s.state='short' THEN 1 ELSE 0 END) AS db_short
    FROM strategies s
    JOIN api_keys a ON a.id = s.api_key_id
    WHERE s.is_active = 1 ${apiKeyFilter}
    GROUP BY s.api_key_id, s.base_symbol
    HAVING (db_long + db_short) >= 1 AND total > 1
    ORDER BY total DESC
  `);

  console.log(`Found ${groups.length} (api_key, symbol) groups with shared positions and >1 strategies`);

  const planned = []; // {strategy_id, api_key, symbol, prev_state}
  const pkCache = {}; // api_key -> positions array

  for (const g of groups) {
    const owners = await db.all(
      `SELECT id, name, state, updated_at, created_at FROM strategies
       WHERE api_key_id = ? AND base_symbol = ? AND is_active = 1 AND state != 'flat'
       ORDER BY created_at ASC, id ASC`,
      [g.api_key_id, g.base_symbol]
    );
    if (owners.length <= 1) continue;

    let exchangeSide = null;
    if (getPositions) {
      try {
        if (!pkCache[g.api_key]) {
          pkCache[g.api_key] = await getPositions(g.api_key);
        }
        const pos = (pkCache[g.api_key] || []).find((p) =>
          String(p?.symbol || '').toUpperCase() === String(g.base_symbol).toUpperCase()
          && parseFloat(String(p?.size || '0')) > 0
        );
        if (pos) {
          const s = String(pos?.side || '').toLowerCase();
          exchangeSide = s === 'buy' ? 'long' : (s === 'sell' ? 'short' : null);
        } else {
          exchangeSide = 'flat';
        }
      } catch (e) {
        console.log(`[warn] getPositions(${g.api_key}) failed: ${e.message}`);
      }
    }

    // Resolve keeper
    let keeper = null;
    if (exchangeSide && exchangeSide !== 'flat') {
      keeper = owners.find((o) => o.state === exchangeSide) || owners[0];
    } else if (exchangeSide === 'flat') {
      // Exchange is flat — no real owner exists; flatten ALL.
      keeper = null;
    } else {
      keeper = owners[0];
    }

    for (const o of owners) {
      if (keeper && o.id === keeper.id) continue;
      planned.push({
        strategy_id: o.id,
        api_key: g.api_key,
        symbol: g.base_symbol,
        prev_state: o.state,
        reason: exchangeSide === 'flat' ? 'exchange_flat_clear_zombies' : `keeper=${keeper ? keeper.id : 'none'} side=${exchangeSide || 'unknown'}`,
      });
    }
  }

  console.log(`\nPlanned ${planned.length} strategies to mark flat (no exchange order).`);
  for (const p of planned.slice(0, 60)) {
    console.log(`  strat=${p.strategy_id} api=${p.api_key} sym=${p.symbol} prev=${p.prev_state} :: ${p.reason}`);
  }
  if (planned.length > 60) console.log(`  ... ${planned.length - 60} more`);

  if (!APPLY) {
    console.log('\n[dry-run] pass --apply to write changes');
    process.exit(0);
  }

  let ok = 0, fail = 0;
  for (const p of planned) {
    try {
      await db.run(
        `UPDATE strategies SET state='flat', entry_ratio=NULL, tp_anchor_ratio=NULL,
                                last_action=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP
         WHERE id = ?`,
        [`reconcile_marked_flat_was_${p.prev_state}`, p.strategy_id]
      );
      ok += 1;
    } catch (e) {
      console.error(`[err] strategy ${p.strategy_id}: ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\nApplied: ${ok} ok, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Reconcile zombie / orphan strategies vs live exchange positions.
 *
 * Modes (--mode=...; default = flatten-zombies):
 *
 *   flatten-zombies (DEFAULT, the original behaviour)
 *     For (api_key, base_symbol) groups with multiple non-flat DB strategies
 *     but only ONE real exchange position, keep the keeper (matching exchange
 *     side, oldest first) and mark the rest state='flat' WITHOUT touching the
 *     exchange. This eliminates zombies that thrash siblings via
 *     closeAllForSymbol on every exit.
 *
 *   force-close
 *     For (api_key, base_symbol) groups where ALL DB strategies are flat but
 *     a live exchange position exists (orphan), call closePosition on the
 *     exchange to remove the orphan. Use when adopt-live is undesirable
 *     (e.g. unknown entry, parameters reset, abandoned manual position).
 *
 *   adopt-live
 *     For orphan exchange positions (DB fully flat for that symbol) try to
 *     adopt the position into the most recently updated active strategy on
 *     that (api_key, symbol) by writing state ('long'|'short'),
 *     entry_ratio = live entry price, last_action = 'reconcile_adopted_live'.
 *     This is the safer fix for accidental close-all (like the 2026-05-02
 *     ORDIUSDT incident) — bot keeps trailing TP from real entry rather than
 *     liquidating a profitable position.
 *
 * Common flags:
 *   --apply                actually write / call exchange (default = dry-run)
 *   --api-key=NAME         restrict to one api_key
 *   --symbol=SYM           restrict to one base_symbol (e.g. ORDIUSDT)
 *
 * Examples:
 *   node tools/reconcile_zombie_strategies.js
 *   node tools/reconcile_zombie_strategies.js --mode=adopt-live --apply
 *   node tools/reconcile_zombie_strategies.js --mode=force-close --api-key=artursk-5497016674-api --symbol=ORDIUSDT --apply
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
const onlySymArg = args.find((a) => a.startsWith('--symbol='));
const ONLY_SYMBOL = onlySymArg ? onlySymArg.split('=')[1].toUpperCase() : null;
const modeArg = args.find((a) => a.startsWith('--mode='));
const MODE = modeArg ? modeArg.split('=')[1] : 'flatten-zombies';
const VALID_MODES = ['flatten-zombies', 'force-close', 'adopt-live'];
if (!VALID_MODES.includes(MODE)) {
  console.error(`Invalid --mode=${MODE}; valid: ${VALID_MODES.join('|')}`);
  process.exit(1);
}

const normSide = (s) => {
  const v = String(s || '').toLowerCase();
  if (v === 'buy' || v === 'long') return 'long';
  if (v === 'sell' || v === 'short') return 'short';
  return null;
};

(async () => {
  const sqlite3 = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'sqlite3')).verbose();
  const { open } = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'sqlite'));

  const db = await open({ filename: DB_PATH, driver: sqlite3.Database });
  await db.exec('PRAGMA busy_timeout = 30000;');

  // Try to import live exchange functions from the running backend
  let getPositions = null;
  let closePosition = null;
  let ensureExchangeClientInitialized = null;
  try {
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const exch = require(path.resolve(__dirname, '..', 'backend', 'dist', 'bot', 'exchange.js'));
    getPositions = exch.getPositions;
    closePosition = exch.closePosition;
    ensureExchangeClientInitialized = exch.ensureExchangeClientInitialized;
    console.log('[info] using live exchange.js from backend/dist/bot/');
  } catch (e) {
    console.log(`[warn] backend dist not loadable: ${e.message}`);
    if (MODE !== 'flatten-zombies') {
      console.error(`[fatal] mode=${MODE} requires live exchange.js — make sure 'cd backend && npm run build' has been run`);
      process.exit(1);
    }
  }

  const apiKeyFilter = ONLY_API_KEY ? `AND a.name = '${ONLY_API_KEY.replace(/'/g, "''")}'` : '';
  const symbolFilter = ONLY_SYMBOL ? `AND s.base_symbol = '${ONLY_SYMBOL.replace(/'/g, "''")}'` : '';

  const planned = [];
  const pkCache = {};

  const fetchPositions = async (apiKey) => {
    if (!getPositions) return null;
    if (pkCache[apiKey] !== undefined) return pkCache[apiKey];
    try {
      if (ensureExchangeClientInitialized) {
        await ensureExchangeClientInitialized(apiKey);
      }
      pkCache[apiKey] = await getPositions(apiKey);
    } catch (e) {
      console.log(`[warn] getPositions(${apiKey}) failed: ${e.message}`);
      pkCache[apiKey] = [];
    }
    return pkCache[apiKey];
  };

  if (MODE === 'flatten-zombies') {
    const groups = await db.all(`
      SELECT s.api_key_id, a.name AS api_key, s.base_symbol,
             COUNT(*) AS total,
             SUM(CASE WHEN s.state='long' THEN 1 ELSE 0 END) AS db_long,
             SUM(CASE WHEN s.state='short' THEN 1 ELSE 0 END) AS db_short
      FROM strategies s
      JOIN api_keys a ON a.id = s.api_key_id
      WHERE s.is_active = 1 AND IFNULL(s.is_archived,0) = 0
        ${apiKeyFilter} ${symbolFilter}
      GROUP BY s.api_key_id, s.base_symbol
      HAVING (db_long + db_short) >= 1 AND total > 1
      ORDER BY total DESC
    `);
    console.log(`[flatten-zombies] Found ${groups.length} (api_key, symbol) groups with >1 strategies and at least one non-flat`);

    for (const g of groups) {
      const owners = await db.all(
        `SELECT id, name, state, updated_at, created_at FROM strategies
         WHERE api_key_id = ? AND base_symbol = ? AND is_active = 1 AND IFNULL(is_archived,0)=0 AND state != 'flat'
         ORDER BY created_at ASC, id ASC`,
        [g.api_key_id, g.base_symbol]
      );
      if (owners.length <= 1) continue;

      let exchangeSide = null;
      const positions = await fetchPositions(g.api_key);
      if (positions !== null) {
        const pos = (positions || []).find((p) =>
          String(p?.symbol || '').toUpperCase() === String(g.base_symbol).toUpperCase()
          && parseFloat(String(p?.size || '0')) > 0
        );
        exchangeSide = pos ? normSide(pos.side) : 'flat';
      }

      let keeper;
      if (exchangeSide && exchangeSide !== 'flat') {
        keeper = owners.find((o) => o.state === exchangeSide) || owners[0];
      } else if (exchangeSide === 'flat') {
        keeper = null;
      } else {
        keeper = owners[0];
      }

      for (const o of owners) {
        if (keeper && o.id === keeper.id) continue;
        planned.push({
          op: 'mark-flat',
          strategy_id: o.id,
          api_key: g.api_key,
          symbol: g.base_symbol,
          prev_state: o.state,
          reason: exchangeSide === 'flat' ? 'exchange_flat_clear_zombies' : `keeper=${keeper ? keeper.id : 'none'} side=${exchangeSide || 'unknown'}`,
        });
      }
    }
  } else {
    // force-close / adopt-live: scan groups where DB is fully flat but exchange has position
    const candidates = await db.all(`
      SELECT s.api_key_id, a.name AS api_key, s.base_symbol,
             COUNT(*) AS total,
             SUM(CASE WHEN s.state IN ('long','short') THEN 1 ELSE 0 END) AS open_count
      FROM strategies s
      JOIN api_keys a ON a.id = s.api_key_id
      WHERE s.is_active = 1 AND IFNULL(s.is_archived,0) = 0
        ${apiKeyFilter} ${symbolFilter}
      GROUP BY s.api_key_id, s.base_symbol
      HAVING open_count = 0
      ORDER BY a.name, s.base_symbol
    `);
    console.log(`[${MODE}] Scanning ${candidates.length} (api_key, symbol) groups where DB is flat, looking for orphan live positions`);

    for (const g of candidates) {
      const positions = await fetchPositions(g.api_key);
      if (positions === null) continue;
      const pos = (positions || []).find((p) =>
        String(p?.symbol || '').toUpperCase() === String(g.base_symbol).toUpperCase()
        && parseFloat(String(p?.size || '0')) > 0
      );
      if (!pos) continue;

      const side = normSide(pos.side);
      const size = parseFloat(String(pos?.size || '0'));
      const entry = parseFloat(String(pos?.entryPrice || pos?.entry_price || pos?.avgPrice || pos?.openPrice || '0')) || null;

      if (MODE === 'force-close') {
        planned.push({
          op: 'force-close',
          api_key: g.api_key,
          symbol: g.base_symbol,
          live_side: side,
          live_size: size,
          live_entry: entry,
          reason: 'orphan_live_position_db_flat',
        });
      } else {
        const target = await db.get(
          `SELECT id, name, state, updated_at FROM strategies
           WHERE api_key_id = ? AND base_symbol = ? AND is_active = 1 AND IFNULL(is_archived,0) = 0
           ORDER BY updated_at DESC, id DESC LIMIT 1`,
          [g.api_key_id, g.base_symbol]
        );
        if (!target) {
          console.log(`[adopt-live] no active strategy to adopt into for ${g.api_key}/${g.base_symbol}`);
          continue;
        }
        if (!side || !entry) {
          console.log(`[adopt-live] missing side/entry for ${g.api_key}/${g.base_symbol} (side=${side} entry=${entry}) — skip`);
          continue;
        }
        planned.push({
          op: 'adopt-live',
          strategy_id: target.id,
          api_key: g.api_key,
          symbol: g.base_symbol,
          new_state: side,
          new_entry: entry,
          live_size: size,
          reason: 'adopt_orphan_live_into_target',
        });
      }
    }
  }

  console.log(`\nPlanned ${planned.length} operations`);
  for (const p of planned.slice(0, 80)) {
    console.log(`  ${JSON.stringify(p)}`);
  }
  if (planned.length > 80) console.log(`  ... ${planned.length - 80} more`);

  if (!APPLY) {
    console.log('\n[dry-run] pass --apply to execute');
    process.exit(0);
  }

  let ok = 0, fail = 0;
  for (const p of planned) {
    try {
      if (p.op === 'mark-flat') {
        await db.run(
          `UPDATE strategies SET state='flat', entry_ratio=NULL, tp_anchor_ratio=NULL,
                                  last_action=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP
           WHERE id = ?`,
          [`reconcile_marked_flat_was_${p.prev_state}`, p.strategy_id]
        );
      } else if (p.op === 'adopt-live') {
        await db.run(
          `UPDATE strategies SET state=?, entry_ratio=?, tp_anchor_ratio=?,
                                  last_action=?, last_error=NULL, updated_at=CURRENT_TIMESTAMP
           WHERE id = ?`,
          [p.new_state, p.new_entry, p.new_entry, `reconcile_adopted_live@${p.new_entry}`, p.strategy_id]
        );
      } else if (p.op === 'force-close') {
        if (!closePosition) throw new Error('closePosition not available');
        const closeSide = p.live_side === 'long' ? 'Sell' : 'Buy';
        const result = await closePosition(p.api_key, p.symbol, closeSide, p.live_size);
        console.log(`  force-close ${p.api_key}/${p.symbol}: ${JSON.stringify(result)}`);
      }
      ok += 1;
    } catch (e) {
      console.error(`[err] op=${p.op} ${p.api_key}/${p.symbol}: ${e.message}`);
      fail += 1;
    }
  }
  console.log(`\nApplied: ${ok} ok, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

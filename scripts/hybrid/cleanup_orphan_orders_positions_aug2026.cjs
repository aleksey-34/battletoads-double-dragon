#!/usr/bin/env node
/**
 * Emergency cleanup after hamfive remat:
 *  1) cancel ALL open orders (old MRS leftovers + spam)
 *  2) force-close orphan positions bypassing apiTradingSymbols gate
 *  3) optionally dematerialize a slug
 *
 *   cd /opt/battletoads-double-dragon/backend && \
 *     node ../scripts/hybrid/cleanup_orphan_orders_positions_aug2026.cjs
 *
 * Env:
 *   DRY=1
 *   ONLY=arcopy1,artursk-6323499563-api
 *   ORPHAN_SYMBOLS=ASTERUSDT,OUSDT,HEMIUSDT,MONUSDT,ACUUSDT
 *   DEMAT_SLUG=artursk-1756891154
 *   SKIP_CANCEL=1
 *   SKIP_CLOSE=1
 */
const path = require('path');
const root = process.env.BTDD_BACKEND || path.join(__dirname, '..', '..', 'backend');
const database = require(path.join(root, 'dist/utils/database.js'));
const exchange = require(path.join(root, 'dist/bot/exchange.js'));
const weexMod = require(path.join(root, 'dist/bot/weexClient.js'));

const DRY = process.env.DRY === '1';
const SKIP_CANCEL = process.env.SKIP_CANCEL === '1';
const SKIP_CLOSE = process.env.SKIP_CLOSE === '1';
const ONLY = (process.env.ONLY || '').split(',').map((s) => s.trim()).filter(Boolean);
const ORPHAN_SYMBOLS = new Set(
  (process.env.ORPHAN_SYMBOLS || 'ASTERUSDT,OUSDT,HEMIUSDT,MONUSDT,ACUUSDT')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean),
);
const DEMAT_SLUG = (process.env.DEMAT_SLUG || '').trim();
const KEEP_B3 = new Set(['ADAUSDT', 'DOGEUSDT', 'WLDUSDT', 'ORDIUSDT', 'SUIUSDT', 'NEARUSDT']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const normSym = (s) => String(s || '').replace(/[:/].*$/, '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();

(async () => {
  await database.initDB();
  const { db } = database;
  const {
    ensureExchangeClientInitialized,
    getPositions,
    cancelAllOrders,
    fetchOpenOrders,
    invalidatePositionCache,
  } = exchange;
  const { createWeexClient } = weexMod;

  const keyRows = await db.all(`
    SELECT DISTINCT a.name AS name, a.id AS id, a.exchange AS exchange
    FROM api_keys a
    JOIN algofund_profiles ap
      ON ap.execution_api_key_name = a.name OR ap.assigned_api_key_name = a.name
    WHERE a.exchange = 'weex'
      AND (
        COALESCE(ap.actual_enabled,0)=1
        OR ap.tenant_id IN (SELECT id FROM tenants WHERE slug = ?)
      )
    ORDER BY a.name
  `, [DEMAT_SLUG || '__none__']);

  let keys = keyRows.map((r) => r.name);
  if (ONLY.length) keys = keys.filter((k) => ONLY.includes(k));
  console.log(`keys=${keys.length} dry=${DRY} orphans=[${[...ORPHAN_SYMBOLS].join(',')}] demat=${DEMAT_SLUG || '-'}`);

  // --- dematerialize slug first (disable + archive runtime) ---
  if (DEMAT_SLUG) {
    const tenant = await db.get(`SELECT id, slug FROM tenants WHERE slug = ?`, [DEMAT_SLUG]);
    if (!tenant) {
      console.log(`DEMAT slug not found: ${DEMAT_SLUG}`);
    } else {
      const profile = await db.get(`SELECT id, execution_api_key_name, assigned_api_key_name FROM algofund_profiles WHERE tenant_id=?`, [tenant.id]);
      const apiKey = profile?.execution_api_key_name || profile?.assigned_api_key_name || '';
      console.log(`\n=== DEMAT ${DEMAT_SLUG} tenant=${tenant.id} api=${apiKey} ===`);
      if (!DRY) {
        await db.run(`UPDATE algofund_profiles SET requested_enabled=0, actual_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE tenant_id=?`, [tenant.id]);
        await db.run(`UPDATE algofund_active_portfolios SET is_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE profile_id=?`, [profile.id]);
        if (apiKey) {
          await db.run(`
            UPDATE strategies SET is_active=0, is_runtime=0, is_archived=1, auto_update=0, updated_at=CURRENT_TIMESTAMP
            WHERE api_key_id=(SELECT id FROM api_keys WHERE name=?) AND COALESCE(is_runtime,0)=1
          `, [apiKey]);
          await db.run(`
            UPDATE trading_systems SET is_active=0, updated_at=CURRENT_TIMESTAMP
            WHERE api_key_id=(SELECT id FROM api_keys WHERE name=?) AND name LIKE ?
          `, [apiKey, `ALGOFUND::${DEMAT_SLUG}::%`]);
        }
        console.log('  disabled profile + archived runtime strategies');
      } else {
        console.log('  DRY would disable profile + archive runtime');
      }
      if (apiKey && !keys.includes(apiKey)) keys.push(apiKey);
    }
  }

  let totalOrders = 0;
  let cancelled = 0;
  let closed = 0;
  let failed = 0;

  for (const name of keys) {
    console.log(`\n==== ${name} ====`);
    try {
      await ensureExchangeClientInitialized(name);
      const row = await db.get(`SELECT * FROM api_keys WHERE name=?`, [name]);
      if (!row) { console.log('  missing api key row'); continue; }
      const weex = createWeexClient(row);

      // open orders
      let orders = [];
      try {
        if (typeof fetchOpenOrders === 'function') orders = await fetchOpenOrders(name) || [];
        else orders = await weex.fetchOpenOrders() || [];
      } catch (e) {
        console.log(`  fetchOpenOrders FAIL: ${e.message || e}`);
      }
      totalOrders += orders.length;
      console.log(`  openOrders=${orders.length}`);
      // classify
      const bySym = {};
      for (const o of orders) {
        const sym = normSym(o.symbol || o.instId || o.contract);
        bySym[sym] = (bySym[sym] || 0) + 1;
      }
      const top = Object.entries(bySym).sort((a, b) => b[1] - a[1]).slice(0, 12)
        .map(([s, n]) => `${s}:${n}`).join(' ');
      if (top) console.log(`  orderSyms ${top}`);

      if (!SKIP_CANCEL && orders.length) {
        if (DRY) {
          console.log(`  DRY cancelAllOrders (${orders.length})`);
        } else {
          try {
            if (typeof cancelAllOrders === 'function') await cancelAllOrders(name);
            else await weex.cancelAllOrders();
            cancelled += orders.length;
            console.log(`  cancelAllOrders OK (~${orders.length})`);
          } catch (e) {
            failed += 1;
            console.log(`  cancelAllOrders FAIL: ${e.message || e}`);
            // per-order fallback
            for (const o of orders) {
              try {
                const id = o.id || o.orderId;
                const sym = o.symbol || o.instId;
                if (weex.cancelOrder && id) await weex.cancelOrder(id, sym);
              } catch (_) { /* ignore */ }
            }
          }
          await sleep(800);
        }
      }

      // positions
      const positions = (await getPositions(name)) || [];
      const open = positions.filter((p) => Math.abs(Number(p.size || p.contracts || p.positionAmt || 0)) > 0);
      console.log(`  openPositions=${open.length}`);
      for (const p of open) {
        const sym = normSym(p.symbol);
        const size = Number(p.size || p.contracts || p.positionAmt || 0);
        const entry = Number(p.entryPrice || p.avgPrice || 0);
        const mark = Number(p.markPrice || 0);
        const upnl = Number(p.unrealizedPnl || p.unrealizedProfit || 0);
        const notional = Math.abs(size * (mark || entry));
        const isOrphan = ORPHAN_SYMBOLS.has(sym);
        const tag = isOrphan ? 'ORPHAN' : (KEEP_B3.has(sym) ? 'B3' : 'OTHER');
        console.log(`  ${tag.padEnd(6)} ${sym.padEnd(12)} size=${size} entry=${entry} mark=${mark} n~${notional.toFixed(1)} upnl=${upnl}`);

        if (SKIP_CLOSE || !isOrphan) continue;
        if (DRY) {
          console.log(`    DRY force-close ${sym}`);
          continue;
        }
        const closeSide = size > 0 ? 'sell' : 'buy';
        const qty = Math.abs(size);
        try {
          // bypass apiTradingSymbols gate — direct weex v3 reduceOnly
          await weex.createOrder(sym, 'market', closeSide, qty, undefined, { reduceOnly: true });
          closed += 1;
          console.log(`    FORCE-CLOSED ${sym}`);
          if (typeof invalidatePositionCache === 'function') invalidatePositionCache(name);
          await sleep(600);
        } catch (e1) {
          try {
            // retry without reduceOnly
            await weex.createOrder(sym, 'market', closeSide, qty, undefined, {});
            closed += 1;
            console.log(`    FORCE-CLOSED ${sym} (no reduceOnly)`);
            if (typeof invalidatePositionCache === 'function') invalidatePositionCache(name);
            await sleep(600);
          } catch (e2) {
            failed += 1;
            console.log(`    FORCE-CLOSE FAIL ${sym}: ${e2.message || e2}`);
          }
        }
      }
    } catch (e) {
      failed += 1;
      console.log(`  KEY FAIL: ${e.message || e}`);
    }
  }

  console.log(`\nDone ordersSeen=${totalOrders} cancelled~=${cancelled} orphanClosed=${closed} failed=${failed} dry=${DRY}`);
  process.exit(failed && !DRY ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

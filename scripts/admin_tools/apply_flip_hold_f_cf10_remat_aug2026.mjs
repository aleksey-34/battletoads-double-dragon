#!/usr/bin/env node
/**
 * Apply F+cf1.0 portfolio pack (safe, no forced closes):
 *   - B3 OP 12→16 (lot 15)
 *   - disable portfolioCircuitBreaker on storefront portfolios + related master cards
 *   - zz_breakout detection_source → wick (exit logic is live flip-hold+cf1.0 in code)
 *   - sync portfolio-b3-core-shared max_open_positions=16
 *   - safe remat all enabled portfolio tenants (preserveOpenExposure)
 *
 *   node scripts/admin_tools/apply_flip_hold_f_cf10_remat_aug2026.mjs [--dry-run] [--skip-remat] [--slug=x]
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../../backend');

const { initDB } = require(path.join(backendRoot, 'dist/utils/database.js'));
const ex = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const { materializeAlgofundPortfolioFull } = require(path.join(backendRoot, 'dist/saas/service.js'));

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const skipRemat = args.includes('--skip-remat');
const slugFilter = args.find((a) => a.startsWith('--slug='))?.split('=')[1];

const B3_OP = 16;
const B3_SOURCE = 'portfolio-b3-core-shared-jul2026';

const snapPos = async (key) => {
  await ex.ensureExchangeClientInitialized(key).catch(() => {});
  const pos = await ex.getPositions(key).catch(() => []);
  const list = Array.isArray(pos) ? pos : (pos?.positions || []);
  return list
    .filter((p) => Math.abs(Number(p.size || p.contracts || 0)) > 0)
    .map((p) => ({
      sym: String(p.symbol || p.info?.symbol || '').replace(/:/g, ''),
      upnl: Number(p.unrealisedPnl || p.unrealizedPnl || 0),
    }));
};

const main = async () => {
  await initDB();
  const { db } = require(path.join(backendRoot, 'dist/utils/database.js'));

  console.log(`Apply F+cf1.0 B3 OP=${B3_OP}, CB off, wick zz_breakout${dryRun ? ' (dry-run)' : ''}`);

  // 1) Portfolio metadata books + CB
  const portfolios = await db.all(
    `SELECT id, set_key, metadata_json FROM algofund_portfolios
     WHERE COALESCE(is_enabled,1)=1 AND COALESCE(is_storefront,0)=1`,
  );
  let pfPatched = 0;
  for (const row of portfolios) {
    let meta = {};
    try { meta = JSON.parse(row.metadata_json || '{}'); } catch { meta = {}; }
    const books = Array.isArray(meta.books) ? meta.books : [];
    let changed = false;
    for (const b of books) {
      if (String(b.key || b.role || '') === 'b3' && Number(b.op) !== B3_OP) {
        b.op = B3_OP;
        if (!(Number(b.lot) > 0)) b.lot = 15;
        changed = true;
      }
    }
    if (meta.portfolioCircuitBreaker && meta.portfolioCircuitBreaker.enabled !== false) {
      meta.portfolioCircuitBreaker = {
        ...(typeof meta.portfolioCircuitBreaker === 'object' ? meta.portfolioCircuitBreaker : {}),
        enabled: false,
      };
      changed = true;
    } else if (!meta.portfolioCircuitBreaker) {
      meta.portfolioCircuitBreaker = { enabled: false };
      changed = true;
    }
    meta.books = books;
    meta.flipHoldPack = 'F_cf10_aug2026';
    meta.flipHoldNote = 'zz_breakout wick+flip_only+cf1.0; B3 OP16 lot15; tierCB off';
    if (changed || meta.flipHoldPack) {
      pfPatched += 1;
      console.log(`  portfolio ${row.set_key}: b3.op→${B3_OP}, CB off`);
      if (!dryRun) {
        await db.run(
          `UPDATE algofund_portfolios SET metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
          [JSON.stringify(meta), row.id],
        );
      }
    }
  }
  console.log(`portfolios patched: ${pfPatched}`);

  // 2) Shared B3 master trading system OP
  const b3Ts = await db.get(
    `SELECT id, name, max_open_positions FROM trading_systems
     WHERE name=? OR name LIKE ? ORDER BY id DESC LIMIT 1`,
    [B3_SOURCE, `%${B3_SOURCE}%`],
  );
  if (b3Ts) {
    console.log(`  master TS #${b3Ts.id} ${b3Ts.name}: max_open ${b3Ts.max_open_positions} → ${B3_OP}`);
    if (!dryRun) {
      await db.run(`UPDATE trading_systems SET max_open_positions=? WHERE id=?`, [B3_OP, b3Ts.id]);
    }
  } else {
    console.warn('  WARN: shared B3 trading system not found');
  }

  // 3) Master cards for portfolio / b3-core: OP + CB off
  const cards = await db.all(
    `SELECT code, metadata_json FROM master_cards WHERE is_active=1
     AND (
       lower(code) LIKE '%portfolio-b3-core%'
       OR lower(code) LIKE '%portfolio-conservative%'
       OR lower(code) LIKE '%portfolio-balanced%'
       OR lower(code) LIKE '%portfolio-aggressive%'
       OR lower(code) LIKE '%portfolio-quality%'
       OR lower(code) LIKE '%portfolio-triple%'
       OR lower(code) LIKE '%hamfive%'
     )`,
  );
  let cardsPatched = 0;
  for (const row of cards) {
    let meta = {};
    try { meta = JSON.parse(row.metadata_json || '{}'); } catch { meta = {}; }
    let changed = false;
    if (Number(meta.maxOpenPositions) !== B3_OP && (
      String(row.code).toLowerCase().includes('b3-core')
      || Number(meta.maxOpenPositions) === 12
    )) {
      // Only bump obvious B3-12 cards; portfolio cards may use book-level op
      if (String(row.code).toLowerCase().includes('b3-core') || String(row.code).toLowerCase().includes('portfolio-b3')) {
        meta.maxOpenPositions = B3_OP;
        changed = true;
      }
    }
    if (meta.portfolioCircuitBreaker?.enabled) {
      meta.portfolioCircuitBreaker = { ...meta.portfolioCircuitBreaker, enabled: false };
      changed = true;
    }
    if (meta.backtestSettings?.portfolioCircuitBreaker?.enabled) {
      meta.backtestSettings.portfolioCircuitBreaker = {
        ...meta.backtestSettings.portfolioCircuitBreaker,
        enabled: false,
      };
      changed = true;
    }
    if (changed) {
      cardsPatched += 1;
      if (!dryRun) {
        await db.run(`UPDATE master_cards SET metadata_json=? WHERE code=?`, [JSON.stringify(meta), row.code]);
      }
    }
  }
  console.log(`master_cards patched: ${cardsPatched}`);

  // 4) Live client/copy B3 books max_open + zz_breakout wick
  const b3Books = await db.all(
    `SELECT id, name, max_open_positions FROM trading_systems
     WHERE name LIKE 'ALGOFUND::%::b3' OR name LIKE 'ALGOFUND_MASTER::%::b3'
        OR name = ? OR name LIKE '%portfolio-b3-core-shared%'`,
    [B3_SOURCE],
  );
  let tsOp = 0;
  for (const ts of b3Books) {
    if (Number(ts.max_open_positions) === B3_OP) continue;
    tsOp += 1;
    console.log(`  TS OP ${ts.name}: ${ts.max_open_positions} → ${B3_OP}`);
    if (!dryRun) {
      await db.run(`UPDATE trading_systems SET max_open_positions=? WHERE id=?`, [B3_OP, ts.id]);
    }
  }
  console.log(`trading_systems OP bumped: ${tsOp}`);

  const wickRes = dryRun
    ? { changes: 0 }
    : await db.run(
      `UPDATE strategies SET detection_source='wick'
       WHERE strategy_type IN ('zz_breakout','DD_BattleToads')
         AND IFNULL(is_archived,0)=0
         AND detection_source != 'wick'`,
    );
  console.log(`zz_breakout → wick: ${wickRes?.changes ?? '(dry)'}`);

  if (skipRemat || dryRun) {
    console.log(dryRun ? 'dry-run done (no remat)' : 'skip-remat');
    return;
  }

  // 5) Safe remat fleet
  let q = `
    SELECT t.id tid, t.slug, p.set_key portfolio,
      COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name) key_name
    FROM tenants t
    JOIN algofund_profiles ap ON ap.tenant_id = t.id
    JOIN algofund_active_portfolios aap ON aap.profile_id = ap.id AND COALESCE(aap.is_enabled,1)=1
    JOIN algofund_portfolios p ON p.id = aap.portfolio_id
    WHERE t.status NOT IN ('deleted','keys_invalid')
      AND COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name) != ''
      AND COALESCE(p.is_enabled,1)=1
    ORDER BY p.set_key, t.slug`;
  const rows = slugFilter
    ? await db.all(`${q.replace('ORDER BY', 'AND t.slug = ? ORDER BY')}`, [slugFilter])
    : await db.all(q);

  console.log(`\nSafe remat ${rows.length} tenants (preserveOpenExposure=true)`);
  const summary = [];
  for (const row of rows) {
    const before = await snapPos(row.key_name);
    console.log(`\n--- ${row.slug} (${row.portfolio}) key=${row.key_name} open=${before.length}`);
    try {
      const result = await materializeAlgofundPortfolioFull({
        tenantId: Number(row.tid),
        setKey: row.portfolio,
        activate: true,
        preserveOpenExposure: true,
        cancelOrdersAfter: true,
      });
      const after = await snapPos(row.key_name);
      const closed = before.filter((p) => !after.some((a) => a.sym === p.sym));
      // Re-assert B3 OP after remat (source card may rewrite)
      await db.run(
        `UPDATE trading_systems SET max_open_positions=?
         WHERE name=? OR name=?`,
        [B3_OP, `ALGOFUND::${row.slug}::b3`, B3_SOURCE],
      );
      await db.run(
        `UPDATE strategies SET detection_source='wick'
         WHERE strategy_type IN ('zz_breakout','DD_BattleToads')
           AND api_key_id = (SELECT id FROM api_keys WHERE name=? LIMIT 1)
           AND IFNULL(is_archived,0)=0`,
        [row.key_name],
      );
      console.log(`BOOKS ${result.systems.map((s) => `${s.role}:${s.strategyCount}`).join(' ')}`);
      if (closed.length) {
        console.log(`!!! CLOSED ${closed.map((p) => p.sym).join(',')}`);
      } else {
        console.log('OK positions preserved');
      }
      summary.push({
        slug: row.slug,
        portfolio: row.portfolio,
        closed: closed.length,
        orphans: result.exchangeOrphansAfter?.length || 0,
      });
    } catch (e) {
      console.error(`FAIL ${row.slug}:`, e.message);
      summary.push({ slug: row.slug, error: e.message });
    }
  }
  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary, null, 2));
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

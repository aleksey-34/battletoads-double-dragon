#!/usr/bin/env node
/**
 * Shared-deposit portfolio BT (correct live semantics):
 *   - ONE client deposit (recipe core capital — stocks do NOT add cash)
 *   - Each book keeps its own OP / lot / reinvest
 *   - All books share one equity + reinvest compound
 *   - Stocks legs join when candles exist (skipMissingSymbols); no +$5k
 *
 *   MRS2_BT_SAME_BAR_EXIT=block node scripts/hybrid/bt_storefront_six_shared_deposit_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const HAM_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const RECIPE = path.join(REPO, 'scripts/hybrid/portfolio_six_data_jul2026/recipes.json');
const WF = path.join(HAM_DIR, 'weex_mrs_engine_wf_postfill.json');
const OUT_DIR = path.join(REPO, 'results/stocks_hf_research_aug2026');
const OUT = path.join(OUT_DIR, 'storefront_six_shared_deposit_bt.json');
const OUT_MD = path.join(OUT_DIR, 'storefront_six_shared_deposit_bt.md');

const CRYPTO_MERGED = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCK_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_staggered_aug2026');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const KEY = 'BTDD_D1';
const B3_SYSTEM_ID = Number(process.env.B3_SYSTEM_ID || 205);
const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || '2026-07-16';
const DATE_FROM_SHORT = process.env.DATE_FROM_SHORT || '2026-03-19';
const STOCK_LEG_PATTERN = 'HFSTOCK::BOOK_4h_s0.2_live8%';

const TIER_CB = {
  enabled: true, peakWindowDays: 30, ddTriggerPercent: 8,
  lotMultiplier: 0.5, pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const hasCandle = (bundle, iv, sym) => fs.existsSync(path.join(bundle, iv, `${sym}.json`));

const ensureMerged = () => {
  ensureDir(MERGED);
  for (const src of [CRYPTO_MERGED, STOCK_BUNDLE]) {
    if (!fs.existsSync(src)) continue;
    for (const iv of fs.readdirSync(src)) {
      const d = path.join(src, iv);
      if (!fs.statSync(d).isDirectory()) continue;
      const outIv = path.join(MERGED, iv);
      ensureDir(outIv);
      for (const f of fs.readdirSync(d).filter((x) => x.endsWith('.json'))) {
        const dst = path.join(outIv, f);
        if (fs.existsSync(dst)) continue;
        try { fs.symlinkSync(path.join(d, f), dst); }
        catch { fs.copyFileSync(path.join(d, f), dst); }
      }
    }
  }
  process.env.HYBRID_CANDLE_DIR = MERGED;
};

const sum = (r, initial) => {
  const s = r.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    final: +Number(s.finalEquity || s.finalBalance || initial).toFixed(2),
    skippedOP: +(s.skippedByPositionLimit || 0),
  };
};

// Minimal MRS upsert (same naming as staggered script)
const upsertMrs = async (db, leg, tag) => {
  const name = `PF6::MRS::${tag}::${leg.symbol}::${leg.tf}`;
  const p = leg.params || {};
  const existing = await db.get(
    `SELECT s.id FROM strategies s JOIN api_keys a ON a.id=s.api_key_id WHERE a.name=? AND s.name=?`,
    [KEY, name],
  );
  if (existing?.id) return Number(existing.id);
  const ak = await db.get(`SELECT id FROM api_keys WHERE name=?`, [KEY]);
  const mrs2 = JSON.stringify({
    maLongLen: p.maLongLen || 5,
    maLongMult: p.maLongMult ?? 0.95,
    maShortLen: p.maShortLen || 5,
    maShortMult: p.maShortMult ?? 1.05,
    maCloseLongLen: p.maCloseLongLen || 5,
    maCloseLongMult: p.maCloseLongMult ?? 1,
    maCloseShortLen: p.maCloseShortLen || 5,
    maCloseShortMult: p.maCloseShortMult ?? 1,
    distanceFilterPct: p.distanceFilterPct ?? 0.3,
    slLongPct: 0,
    slShortPct: 0,
  });
  const r = await db.run(
    `INSERT INTO strategies (
      api_key_id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval,
      is_active, auto_update, long_enabled, short_enabled, lot_long_percent, lot_short_percent,
      reinvest_percent, max_deposit, leverage, margin_type, mrs2_config_json,
      zscore_entry, zscore_exit, zscore_stop, price_channel_length
    ) VALUES (?,?,?,?,?,?,?,1,1,1,1,6,6,100,0,1,'cross',?,?,?,?,?)`,
    [
      ak.id, name, 'MeanReversion', 'mono', leg.symbol, 'USDT', leg.tf,
      mrs2, p.maLongMult ?? 0.95, p.maShortMult ?? 1.05, p.distanceFilterPct ?? 0.3,
      Math.max(p.maLongLen || 5, p.maShortLen || 5),
    ],
  );
  return Number(r.lastID);
};

const coreDeposit = (pf) => pf.books
  .filter((b) => b.key !== 'stocks')
  .reduce((s, b) => s + Number(b.initial || 0), 0);

const main = async () => {
  ensureMerged();
  ensureDir(OUT_DIR);
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  const durable = wf.durable || wf.cloud || [];

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  const only = (process.env.PORTFOLIOS || recipes.portfolios.map((p) => p.setKey).join(','))
    .split(',').map((s) => s.trim()).filter(Boolean);
  const targets = recipes.portfolios.filter((p) => only.includes(p.setKey));

  const b3Rows = await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3_SYSTEM_ID],
  );
  const b3Ids = b3Rows.map((r) => Number(r.id));

  const stockRows = await db.all(
    `SELECT s.id, s.base_symbol FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
     WHERE a.name=? AND s.name LIKE ? ORDER BY s.id`,
    [KEY, STOCK_LEG_PATTERN],
  );
  const stockIds = stockRows.filter((r) => hasCandle(MERGED, '4h', r.base_symbol)).map((r) => Number(r.id));

  const zzLegs = (recipes.universes.ham_zz_top5_weex && recipes.universes.ham_zz_top5_weex.legs) || [];
  const zzIds = [];
  for (const z of zzLegs) {
    let row = await db.get(
      `SELECT s.id FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
       WHERE a.name=? AND s.base_symbol=? AND s.interval=? AND s.name LIKE 'FIVECARDFULL::ZZ%'
       ORDER BY s.id DESC LIMIT 1`,
      [KEY, z.symbol, z.tf],
    );
    if (!row?.id) {
      row = await db.get(
        `SELECT s.id FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
         WHERE a.name=? AND s.base_symbol=? AND s.interval=?
           AND s.strategy_type IN ('ZZ_Fast','ZZ_Instance','zz_breakout')
         ORDER BY s.id LIMIT 1`,
        [KEY, z.symbol, z.tf],
      );
    }
    if (row?.id && hasCandle(MERGED, z.tf, z.symbol)) zzIds.push(Number(row.id));
  }

  const mrsCache = new Map();
  for (const n of [20, 25, 30]) {
    const ids = [];
    for (const leg of durable.slice(0, n)) {
      if (!hasCandle(MERGED, leg.tf, leg.symbol)) continue;
      ids.push(await upsertMrs(db, leg, `N${n}`));
    }
    mrsCache.set(n, ids);
    console.log(`MRS N=${n} ids=${ids.length}`);
  }
  console.log(`B3=${b3Ids.length} ZZ=${zzIds.length} stocks=${stockIds.length}`);

  const windows = [
    { tag: 'full', from: DATE_FROM, to: DATE_TO },
    { tag: 'short', from: DATE_FROM_SHORT, to: DATE_TO },
  ];

  const results = [];
  for (const pf of targets) {
    const deposit = coreDeposit(pf);
    for (const w of windows) {
      console.log(`\n=== ${pf.id} ${pf.label} ${w.tag} deposit=$${deposit} ===`);

      const buildBooks = (includeStocks) => {
        const ids = [];
        const maxOpenPositionsByBook = {};
        const bookKeyByStrategyId = {};
        const lotPercentMultiplierByStrategyId = {};
        let maxRi = 0;
        for (const book of pf.books) {
          if (book.key === 'stocks' && !includeStocks) continue;
          let bookIds = [];
          let lot = book.lot;
          let op = book.op;
          let ri = book.ri || 0;
          if (book.key === 'b3') {
            bookIds = b3Ids;
            lot = recipes.sharedB3.lot;
            op = recipes.sharedB3.op;
            ri = recipes.sharedB3.ri;
          } else if (book.key === 'mrs') {
            const u = recipes.universes[book.universe];
            const n = u.n == null ? 30 : u.n;
            bookIds = mrsCache.get(n) || mrsCache.get(30);
          } else if (book.key === 'zz') {
            bookIds = zzIds;
          } else if (book.key === 'stocks') {
            bookIds = stockIds;
            lot = recipes.sharedStocks.lot;
            op = recipes.sharedStocks.op;
            ri = recipes.sharedStocks.ri;
          }
          if (!bookIds.length) continue;
          maxRi = Math.max(maxRi, ri || 0);
          if (op > 0) maxOpenPositionsByBook[book.key] = op;
          for (const sid of bookIds) {
            ids.push(sid);
            bookKeyByStrategyId[String(sid)] = book.key;
            if (lot > 0) lotPercentMultiplierByStrategyId[String(sid)] = lot;
          }
        }
        return {
          ids: [...new Set(ids)],
          maxOpenPositionsByBook,
          bookKeyByStrategyId,
          lotPercentMultiplierByStrategyId,
          maxRi,
        };
      };

      const runShared = async (includeStocks, tag) => {
        const b = buildBooks(includeStocks);
        const r = await runBacktest({
          apiKeyName: KEY,
          mode: 'portfolio',
          strategyIds: b.ids,
          dateFrom: w.from,
          dateTo: w.to,
          bars: 14000,
          warmupBars: 120,
          skipMissingSymbols: true,
          initialBalance: deposit,
          commissionPercent: 0.1,
          slippagePercent: 0.05,
          maxOpenPositions: 0,
          maxOpenPositionsByBook: b.maxOpenPositionsByBook,
          bookKeyByStrategyId: b.bookKeyByStrategyId,
          lotPercentOverride: 1,
          lotPercentMultiplierByStrategyId: b.lotPercentMultiplierByStrategyId,
          enablePairLock: true,
          maxDepositOverride: b.maxRi > 0 ? deposit * 50 : 0,
          reinvestPercentOverride: b.maxRi,
          portfolioCircuitBreaker: TIER_CB,
        });
        const m = sum(r, deposit);
        console.log(`  ${tag}: ret=${m.ret}% dd=${m.dd}% trades=${m.trades} skipOP=${m.skippedOP} n=${b.ids.length}`);
        return { ...m, n: b.ids.length, books: Object.keys(b.maxOpenPositionsByBook) };
      };

      const core = await runShared(false, 'CORE (no stocks)');
      const withStocks = await runShared(true, 'SAME deposit +stocks');
      results.push({
        window: w.tag,
        from: w.from,
        to: w.to,
        id: pf.id,
        setKey: pf.setKey,
        label: pf.label,
        deposit,
        method: 'shared_deposit_one_wallet_per_book_OP',
        mrsSameBarExit: process.env.MRS2_BT_SAME_BAR_EXIT || 'block',
        core,
        withStocks,
        deltaRet: +(withStocks.ret - core.ret).toFixed(2),
        deltaDd: +(withStocks.dd - core.dd).toFixed(2),
      });
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'RESEARCH — shared deposit; NOT a vitrine stamp',
    method: 'shared_deposit_one_wallet_per_book_OP',
    methodNote:
      'One client deposit (= sum of non-stocks recipe initials). Adding stocks keeps the same deposit; '
      + 'stocks only get OP/lot on the shared equity when candles exist. Reinvest compounds on the shared wallet.',
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const lines = [
    '# Storefront six — shared-deposit BT (correct model)',
    '',
    '**One deposit. Books share wallet + reinvest. Stocks do NOT add cash.**',
    '',
    `MRS same-bar: \`${process.env.MRS2_BT_SAME_BAR_EXIT || 'block'}\` · unified costs 0.1/0.05 · per-book OP`,
    '',
    '## Full window',
    '',
    '| Portfolio | Deposit | Core ret/DD | +stocks same $ | Δret |',
    '|---|---:|---|---|---:|',
  ];
  for (const r of results.filter((x) => x.window === 'full')) {
    lines.push(
      `| ${r.label} | $${r.deposit} | ${r.core.ret}% / ${r.core.dd}% | **${r.withStocks.ret}% / ${r.withStocks.dd}%** | ${r.deltaRet} |`,
    );
  }
  lines.push('', '## Short window', '', '| Portfolio | Deposit | Core ret/DD | +stocks same $ | Δret |', '|---|---:|---|---|---:|');
  for (const r of results.filter((x) => x.window === 'short')) {
    lines.push(
      `| ${r.label} | $${r.deposit} | ${r.core.ret}% / ${r.core.dd}% | **${r.withStocks.ret}% / ${r.withStocks.dd}%** | ${r.deltaRet} |`,
    );
  }
  lines.push(
    '',
    'If Δret is still negative here, stocks are hurting **as a trading book on the shared wallet**, not via fake +$5k dilution.',
    '',
  );
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log('\nWrote', OUT);
  console.log('Wrote', OUT_MD);
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

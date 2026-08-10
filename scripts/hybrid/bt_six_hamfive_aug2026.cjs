#!/usr/bin/env node
/**
 * Dual-OP shared-deposit BT for redesigned six (B3 + HAM + FIVECARD ± stocks ZZ).
 * Shows each portfolio WITH and WITHOUT stocks ZZ. No stamp / no live apply.
 *
 *   node scripts/hybrid/bt_six_hamfive_aug2026.cjs
 *
 * Knobs reminder:
 *   OP  = max open positions for that book (per-book cap)
 *   lot = lot_% of equity used when that book's leg opens
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');
const OLD_RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes.json');
const WF = path.join(REPO, 'results/hamster_compound_system89_jul2026/weex_mrs_engine_wf_postfill.json');
const OUT_DIR = path.join(REPO, 'results/b3_flat_helper_hunter_aug2026');
const OUT = path.join(OUT_DIR, 'six_hamfive_bt.json');
const OUT_MD = path.join(OUT_DIR, 'six_hamfive_bt.md');
const CRYPTO = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCKS = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const KEY = 'BTDD_D1';
const B3_SYSTEM_ID = 205;
const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || '2026-07-16';
const DATE_FROM_SHORT = process.env.DATE_FROM_SHORT || '2026-03-19';

const TIER_CB = {
  enabled: true, peakWindowDays: 30, ddTriggerPercent: 8,
  lotMultiplier: 0.5, pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const hasCandle = (bundle, iv, sym) => fs.existsSync(path.join(bundle, iv, `${sym}.json`));

const ensureMerged = () => {
  ensureDir(MERGED);
  for (const src of [CRYPTO, STOCKS]) {
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
    wr: +Number(s.winRatePercent || 0).toFixed(1),
    final: +Number(s.finalEquity || s.finalBalance || initial).toFixed(2),
    skippedOP: +(s.skippedByPositionLimit || 0),
  };
};

const upsertMrs = async (db, leg, tag) => {
  const name = `PF6::MRS::${tag}::${leg.symbol}::${leg.tf}`;
  const existing = await db.get(
    `SELECT s.id FROM strategies s JOIN api_keys a ON a.id=s.api_key_id WHERE a.name=? AND s.name=?`,
    [KEY, name],
  );
  if (existing?.id) return Number(existing.id);
  const ak = await db.get(`SELECT id FROM api_keys WHERE name=?`, [KEY]);
  const p = leg.params || {};
  const mrs2 = JSON.stringify({
    maLongLen: p.maLongLen || 5, maLongMult: p.maLongMult ?? 0.95,
    maShortLen: p.maShortLen || 5, maShortMult: p.maShortMult ?? 1.05,
    maCloseLongLen: p.maCloseLongLen || 5, maCloseLongMult: p.maCloseLongMult ?? 1,
    maCloseShortLen: p.maCloseShortLen || 5, maCloseShortMult: p.maCloseShortMult ?? 1,
    distanceFilterPct: p.distanceFilterPct ?? 0.3, slLongPct: 0, slShortPct: 0,
  });
  const r = await db.run(
    `INSERT INTO strategies (
      api_key_id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval,
      is_active, auto_update, long_enabled, short_enabled, lot_long_percent, lot_short_percent,
      reinvest_percent, max_deposit, leverage, margin_type, mrs2_config_json,
      zscore_entry, zscore_exit, zscore_stop, price_channel_length
    ) VALUES (?,?,?,?,?,?,?,1,1,1,1,6,6,100,0,1,'cross',?,?,?,?,?)`,
    [
      ak.id, name, 'MeanReversion', 'mono', leg.symbol, 'USDT', leg.tf, mrs2,
      p.maLongMult ?? 0.95, p.maShortMult ?? 1.05, p.distanceFilterPct ?? 0.3,
      Math.max(p.maLongLen || 5, p.maShortLen || 5),
    ],
  );
  return Number(r.lastID);
};

const coreDeposit = (pf) => pf.books
  .filter((b) => b.key !== 'stocks')
  .reduce((s, b) => s + Number(b.initial || 0), 0);

(async () => {
  ensureMerged();
  ensureDir(OUT_DIR);
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  const durable = wf.durable || wf.cloud || [];

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const { db } = database;

  const b3Ids = (await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3_SYSTEM_ID],
  )).map((r) => Number(r.id));

  // Resolve universes → ids present in DB + candles
  const resolveIds = async (universeKey) => {
    const u = recipes.universes[universeKey];
    if (!u) return [];
    if (u.ids) {
      const out = [];
      for (const id of u.ids) {
        const row = await db.get(
          `SELECT id, interval, base_symbol, strategy_type FROM strategies WHERE id=?`,
          [id],
        );
        if (!row) { console.warn('missing id', id); continue; }
        if (!hasCandle(MERGED, row.interval, row.base_symbol)) {
          console.warn('no candle', id, row.interval, row.base_symbol);
          continue;
        }
        out.push(Number(row.id));
      }
      return out;
    }
    if (universeKey === 'stocks_zz_4h_l30') {
      const api = new Set(u.apiSymbols);
      const rows = await db.all(
        `SELECT id, base_symbol FROM strategies
         WHERE name LIKE 'CHGRIND::stocks_api::zz_breakout::%::4h::L30'
           AND COALESCE(is_archived,0)=0`,
      );
      return rows
        .filter((r) => api.has(r.base_symbol) && hasCandle(MERGED, '4h', r.base_symbol))
        .map((r) => Number(r.id));
    }
    return [];
  };

  const uniCache = {};
  for (const key of Object.keys(recipes.universes)) {
    uniCache[key] = await resolveIds(key);
    console.log(`universe ${key}: ${uniCache[key].length}`);
  }

  console.log(`B3=${b3Ids.length}`);

  const windows = [
    { tag: 'full', from: DATE_FROM, to: DATE_TO },
    { tag: 'short', from: DATE_FROM_SHORT, to: DATE_TO },
  ];

  const runShared = async (booksSpec, deposit, tag) => {
    const ids = [];
    const maxOpenPositionsByBook = {};
    const bookKeyByStrategyId = {};
    const lotPercentMultiplierByStrategyId = {};
    let maxRi = 0;
    for (const book of booksSpec) {
      let bookIds = [];
      let lot = book.lot;
      let op = book.op;
      let ri = book.ri || 0;
      if (book.key === 'b3') {
        bookIds = b3Ids;
        lot = recipes.sharedB3.lot;
        op = recipes.sharedB3.op;
        ri = recipes.sharedB3.ri;
      } else if (book.universe) {
        bookIds = uniCache[book.universe] || [];
      } else if (book.key === 'mrs_old20') {
        bookIds = oldMrs20;
      }
      if (!bookIds.length) continue;
      maxRi = Math.max(maxRi, ri || 0);
      if (op > 0) maxOpenPositionsByBook[book.key] = op;
      for (const sid of bookIds) {
        ids.push(sid);
        bookKeyByStrategyId[String(sid)] = book.key;
        // Engine clamps lotPercentMultiplier to ≤10. Shared-deposit pattern is
        //   lot = lotPercentOverride * multiplier
        // so use override=2 and multiplier=desiredLot/2 (lots up to 20 stay in range).
        if (lot > 0) lotPercentMultiplierByStrategyId[String(sid)] = lot / 2;
      }
    }
    const unique = [...new Set(ids)];
    const r = await runBacktest({
      apiKeyName: KEY,
      mode: 'portfolio',
      strategyIds: unique,
      dateFrom: booksSpec._from,
      dateTo: booksSpec._to,
      bars: 14000,
      warmupBars: 120,
      skipMissingSymbols: true,
      initialBalance: deposit,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: 0,
      maxOpenPositionsByBook,
      bookKeyByStrategyId,
      lotPercentOverride: 2,
      lotPercentMultiplierByStrategyId,
      enablePairLock: true,
      maxDepositOverride: maxRi > 0 ? deposit * 50 : 0,
      reinvestPercentOverride: maxRi,
      portfolioCircuitBreaker: TIER_CB,
    });
    const m = sum(r, deposit);
    const bookLots = {};
    for (const [sid, bk] of Object.entries(bookKeyByStrategyId)) {
      if (bookLots[bk] == null) bookLots[bk] = (lotPercentMultiplierByStrategyId[sid] || 0) * 2;
    }
    console.log(`  ${tag}: ret=${m.ret}% dd=${m.dd}% pf=${m.pf} tr=${m.trades} skipOP=${m.skippedOP} n=${unique.length} books=${Object.keys(maxOpenPositionsByBook).join(',')} lots=${JSON.stringify(bookLots)}`);
    return {
      ...m,
      n: unique.length,
      books: Object.keys(maxOpenPositionsByBook),
      bookOps: { ...maxOpenPositionsByBook },
      bookLots,
    };
  };

  const results = [];

  // --- NEW six ---
  for (const pf of recipes.portfolios) {
    const deposit = coreDeposit(pf);
    for (const w of windows) {
      console.log(`\n=== NEW ${pf.id} ${pf.label} ${w.tag} deposit=$${deposit} ===`);
      const baseBooks = pf.books.filter((b) => b.key !== 'stocks');
      const withStocksBooks = pf.books; // includes stocks with initial 0

      const mk = (books) => {
        const b = books.map((x) => ({ ...x }));
        b._from = w.from;
        b._to = w.to;
        return b;
      };

      const core = await runShared(mk(baseBooks), deposit, 'NO stocks');
      const withStocks = await runShared(mk(withStocksBooks), deposit, '+stocks ZZ');
      results.push({
        kind: 'new_hamfive',
        window: w.tag,
        from: w.from,
        to: w.to,
        id: pf.id,
        setKey: pf.setKey,
        label: pf.label,
        character: pf.character,
        deposit,
        core,
        withStocks,
        deltaRet: +(withStocks.ret - core.ret).toFixed(2),
        deltaDd: +(withStocks.dd - core.dd).toFixed(2),
        deltaTrades: withStocks.trades - core.trades,
      });
    }
  }

  // --- OLD fat-MRS reference (Conserv/Balanced/Aggressive, no stocks) ---
  for (const spec of [
    { id: 'P1', label: 'OLD Conservative', n: 20, op: 16, lot: 6, deposit: 20000 },
    { id: 'P2', label: 'OLD Balanced', n: 30, op: 16, lot: 6, deposit: 20000 },
    { id: 'P3', label: 'OLD Aggressive', n: 30, op: 20, lot: 8, deposit: 30000 },
  ]) {
    const mrsIds = [];
    for (const leg of durable.slice(0, spec.n)) {
      if (!hasCandle(MERGED, leg.tf, leg.symbol)) continue;
      mrsIds.push(await upsertMrs(db, leg, `N${spec.n}`));
    }
    const ids = [...b3Ids, ...mrsIds];
    const maxOpenPositionsByBook = { b3: 12, mrs: spec.op };
    const bookKeyByStrategyId = {};
    const lotPercentMultiplierByStrategyId = {};
    for (const id of b3Ids) {
      bookKeyByStrategyId[String(id)] = 'b3';
      lotPercentMultiplierByStrategyId[String(id)] = 15 / 2;
    }
    for (const id of mrsIds) {
      bookKeyByStrategyId[String(id)] = 'mrs';
      lotPercentMultiplierByStrategyId[String(id)] = spec.lot / 2;
    }
    console.log(`\n=== ${spec.label} full deposit=$${spec.deposit} MRS${spec.n}=${mrsIds.length} ===`);
    const r = await runBacktest({
      apiKeyName: KEY, mode: 'portfolio', strategyIds: ids,
      dateFrom: DATE_FROM, dateTo: DATE_TO, bars: 14000, warmupBars: 120,
      skipMissingSymbols: true, initialBalance: spec.deposit,
      commissionPercent: 0.1, slippagePercent: 0.05,
      maxOpenPositions: 0, maxOpenPositionsByBook, bookKeyByStrategyId,
      lotPercentOverride: 2, lotPercentMultiplierByStrategyId,
      enablePairLock: true, maxDepositOverride: spec.deposit * 50,
      reinvestPercentOverride: 100, portfolioCircuitBreaker: TIER_CB,
    });
    const core = sum(r, spec.deposit);
    console.log(`  OLD: ret=${core.ret}% dd=${core.dd}% tr=${core.trades}`);
    results.push({
      kind: 'old_mrs', window: 'full', from: DATE_FROM, to: DATE_TO,
      id: spec.id, setKey: `old-${spec.id}`, label: spec.label,
      deposit: spec.deposit, core, withStocks: null, mrsN: spec.n,
    });
  }

  const report = {
    generatedAt: new Date().toISOString(),
    status: 'RESEARCH — show results before stamp/deploy/remat',
    method: 'shared_deposit_one_wallet_per_book_OP',
    knobsExplained: {
      OP: 'max open positions allowed inside that book at once',
      lot: 'percent of shared equity used as position size when a leg in that book opens',
      ri: 'reinvest percent (compound) — max across books applied to shared wallet',
    },
    recipe: RECIPE,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const fullNew = results.filter((r) => r.kind === 'new_hamfive' && r.window === 'full');
  const shortNew = results.filter((r) => r.kind === 'new_hamfive' && r.window === 'short');
  const oldFull = results.filter((r) => r.kind === 'old_mrs' && r.window === 'full');

  const lines = [
    '# Six portfolios — B3+HAM+FIVECARD BT (awaiting approval to stamp)',
    '',
    '**Shared deposit · per-book OP/lot · honest 0.1/0.05 · MRS2 same-bar=block**',
    '',
    '### Knobs',
    '- **OP** — сколько позиций максимум может держать эта книга одновременно',
    '- **lot%** — какой % общего депозита идёт в сделку ноги этой книги',
    '',
    '## Full window — NEW (no stocks vs +stocks ZZ)',
    '',
    '| PF | Deposit | NO stocks ret/DD | Trades | +stocks ZZ ret/DD | Trades | Δret | ΔDD |',
    '|---|---:|---|---:|---|---:|---:|---:|',
    ...fullNew.map((r) => `| ${r.id} ${r.label} | $${r.deposit} | **${r.core.ret}% / ${r.core.dd}%** | ${r.core.trades} | **${r.withStocks.ret}% / ${r.withStocks.dd}%** | ${r.withStocks.trades} | ${r.deltaRet} | ${r.deltaDd} |`),
    '',
    '## Short window — NEW',
    '',
    '| PF | NO stocks | +stocks ZZ | Δret |',
    '|---|---|---|---:|',
    ...shortNew.map((r) => `| ${r.id} ${r.label} | ${r.core.ret}% / ${r.core.dd}% | ${r.withStocks.ret}% / ${r.withStocks.dd}% | ${r.deltaRet} |`),
    '',
    '## OLD fat-MRS reference (full, no stocks)',
    '',
    '| PF | Deposit | Ret/DD | Trades |',
    '|---|---:|---|---:|',
    ...oldFull.map((r) => `| ${r.label} (MRS${r.mrsN}) | $${r.deposit} | ${r.core.ret}% / ${r.core.dd}% | ${r.core.trades} |`),
    '',
    `JSON: \`${OUT}\``,
  ];
  fs.writeFileSync(OUT_MD, lines.join('\n'));
  console.log('\nWrote', OUT);
  console.log('Wrote', OUT_MD);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

#!/usr/bin/env node
/**
 * Quick WEEX-tradable rebuild of HAM + FIVE books + P4 retune.
 * Filters by live apiTradingSymbols allowlist file.
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/b3_flat_helper_hunter_aug2026');
const CRYPTO = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCKS = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026');
const ALLOW = '/tmp/weex_api_trading.json';
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');
const LEGS = path.join(__dirname, 'portfolio_six_data_jul2026/hamfive_legs_aug2026.json');
const SNAPS = path.join(__dirname, 'portfolio_six_data_jul2026/snapshots_hamfive_aug2026.json');
const HUNTER = path.join(OUT_DIR, 'hunter.json');
const EXT = path.join(OUT_DIR, 'hunter_ext_p1.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const KEY = 'BTDD_D1';
const B3_SYSTEM_ID = 205;
const DATE_FROM = '2024-03-17';
const DATE_TO = '2026-07-16';
const DATE_FROM_SHORT = '2026-03-19';

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
  };
};

const exportLeg = async (db, id) => {
  const row = await db.get(
    `SELECT id, name, strategy_type, base_symbol, quote_symbol, interval, price_channel_length,
            zscore_entry, zscore_exit, zscore_stop, mrs2_config_json, lot_long_percent, lot_short_percent,
            leverage, take_profit_percent, detection_source, market_mode, market_type
     FROM strategies WHERE id=?`,
    [id],
  );
  if (!row) throw new Error(`missing ${id}`);
  return row;
};

(async () => {
  ensureMerged();
  const allow = new Set(JSON.parse(fs.readFileSync(ALLOW, 'utf8')));
  const hunter = JSON.parse(fs.readFileSync(HUNTER, 'utf8'));
  const ext = JSON.parse(fs.readFileSync(EXT, 'utf8'));
  const byId = {};
  for (const s of [...(hunter.solo || []), ...(ext.solo || [])]) byId[Number(s.id)] = s;

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const { db } = database;

  const b3Ids = (await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3_SYSTEM_ID],
  )).map((r) => Number(r.id));

  // Candidate HAM89 ZZ on allowlist + candles
  const hamRows = await db.all(
    `SELECT id, name, base_symbol, interval, strategy_type FROM strategies
     WHERE COALESCE(is_archived,0)=0 AND name LIKE 'HAM89::ZZ%'`,
  );
  const hamCand = [];
  for (const r of hamRows) {
    if (!allow.has(r.base_symbol)) continue;
    if (!hasCandle(MERGED, r.interval, r.base_symbol)) continue;
    const known = byId[Number(r.id)];
    hamCand.push({
      id: Number(r.id),
      symbol: r.base_symbol,
      interval: r.interval,
      name: r.name,
      flat: known ? Number(known.flatRetPct || 0) : null,
      trend: known ? Number(known.trendRetPct || 0) : null,
      score: known ? Number(known.score || 0) : null,
      known: Boolean(known),
    });
  }

  // Solo-score unknown HAM quickly
  const unknown = hamCand.filter((x) => !x.known);
  console.log(`HAM candidates weex+candle=${hamCand.length} unknown=${unknown.length}`);
  for (const u of unknown) {
    const r = await runBacktest({
      apiKeyName: KEY, mode: 'portfolio', strategyIds: [u.id],
      dateFrom: DATE_FROM, dateTo: DATE_TO, bars: 14000, warmupBars: 120,
      skipMissingSymbols: true, initialBalance: 10000,
      commissionPercent: 0.1, slippagePercent: 0.05,
      maxOpenPositions: 2, lotPercentOverride: 6,
      enablePairLock: true, maxDepositOverride: 500000,
      reinvestPercentOverride: 100,
    });
    const s = sum(r, 10000);
    u.ret = s.ret; u.dd = s.dd; u.score = s.ret - 1.2 * s.dd;
    console.log(`  solo HAM ${u.id} ${u.symbol} ${u.interval} ret=${s.ret} dd=${s.dd}`);
  }

  // Prefer known flat+ then unknown with ret>0 and not horrible dd
  const hamRanked = [...hamCand].sort((a, b) => {
    const af = a.flat != null ? a.flat : (a.ret || -999);
    const bf = b.flat != null ? b.flat : (b.ret || -999);
    return bf - af;
  });
  const hamPick = [];
  const seenSym = new Set();
  for (const h of hamRanked) {
    if (seenSym.has(h.symbol)) continue;
    // skip known flat drains
    if (h.flat != null && h.flat < 0) continue;
    if (h.flat == null && (h.ret == null || h.ret < 5 || (h.dd || 0) > 35)) continue;
    hamPick.push(h);
    seenSym.add(h.symbol);
    if (hamPick.length >= 8) break;
  }
  // if <8, allow mild unknowns with ret>0
  if (hamPick.length < 8) {
    for (const h of hamRanked) {
      if (hamPick.find((x) => x.id === h.id)) continue;
      if (seenSym.has(h.symbol)) continue;
      if (h.flat != null && h.flat < -2) continue;
      if (h.ret != null && h.ret <= 0) continue;
      hamPick.push(h);
      seenSym.add(h.symbol);
      if (hamPick.length >= 8) break;
    }
  }
  console.log('HAM pick', hamPick.map((x) => `${x.symbol}/${x.interval}`).join(', '));

  // FIVE / thin MR: FIVECARD + CLOUD40 + PF6 KAS on allowlist, prefer trueComp / flat+
  const mrIdsWanted = [
    255343, 255460, 256038, 255458, 255479, 255319, 255302, // MANTA JUP KAS JTO APT ETHFI LYN
    255471, 255238, // SUI LYN addon
  ];
  const fivePick = [];
  const fiveSeen = new Set();
  for (const id of mrIdsWanted) {
    const row = await db.get(`SELECT id,name,base_symbol,interval,strategy_type FROM strategies WHERE id=?`, [id]);
    if (!row) continue;
    if (!allow.has(row.base_symbol)) continue;
    if (!hasCandle(MERGED, row.interval, row.base_symbol)) continue;
    if (fiveSeen.has(row.base_symbol)) continue;
    const known = byId[id];
    if (known && Number(known.flatRetPct || 0) <= 0 && Number(known.ret || 0) < 5) continue;
    fivePick.push({ id: Number(row.id), symbol: row.base_symbol, interval: row.interval, name: row.name, known });
    fiveSeen.add(row.base_symbol);
    if (fivePick.length >= 7) break;
  }
  console.log('FIVE pick', fivePick.map((x) => `${x.symbol}/${x.interval}`).join(', '));

  const stocks = (await db.all(
    `SELECT id, base_symbol FROM strategies
     WHERE name LIKE 'CHGRIND::stocks_api::zz_breakout::%::4h::L30' AND COALESCE(is_archived,0)=0`,
  )).filter((r) => hasCandle(MERGED, '4h', r.base_symbol)).map((r) => Number(r.id));

  const hamIds = hamPick.map((x) => x.id);
  const fiveIds = fivePick.map((x) => x.id);

  const runShared = async (books, deposit) => {
    const ids = [];
    const maxOpenPositionsByBook = {};
    const bookKeyByStrategyId = {};
    const lotPercentMultiplierByStrategyId = {};
    let maxRi = 0;
    for (const book of books) {
      let bookIds = [];
      let lot = book.lot;
      let op = book.op;
      let ri = book.ri || 100;
      if (book.key === 'b3') {
        bookIds = b3Ids; lot = 15; op = 12; ri = 50;
      } else if (book.key === 'ham') bookIds = hamIds.slice(0, book.n || hamIds.length);
      else if (book.key === 'five') bookIds = fiveIds.slice(0, book.n || fiveIds.length);
      else if (book.key === 'stocks') bookIds = stocks;
      if (!bookIds.length) continue;
      maxRi = Math.max(maxRi, ri);
      if (op > 0) maxOpenPositionsByBook[book.key] = op;
      for (const sid of bookIds) {
        ids.push(sid);
        bookKeyByStrategyId[String(sid)] = book.key;
        lotPercentMultiplierByStrategyId[String(sid)] = lot / 2;
      }
    }
    const r = await runBacktest({
      apiKeyName: KEY, mode: 'portfolio', strategyIds: ids,
      dateFrom: books._from || DATE_FROM, dateTo: books._to || DATE_TO,
      bars: 14000, warmupBars: 120, skipMissingSymbols: true,
      initialBalance: deposit, commissionPercent: 0.1, slippagePercent: 0.05,
      maxOpenPositions: 0, maxOpenPositionsByBook, bookKeyByStrategyId,
      lotPercentOverride: 2, lotPercentMultiplierByStrategyId,
      enablePairLock: true, maxDepositOverride: deposit * 50,
      reinvestPercentOverride: Math.max(50, maxRi), portfolioCircuitBreaker: TIER_CB,
    });
    return { ...sum(r, deposit), n: ids.length, books: Object.keys(maxOpenPositionsByBook) };
  };

  // Portfolio designs:
  // P1 Conserv: HAM top4 + FIVE top4, thinner OP/lot
  // P2 Balanced: HAM8 + FIVE7 reference
  // P3 Aggro: same modules higher OP/lot
  // P4 Quality: SAME full WEEX modules as P2 but "quality gas" — slightly lower OP than P2,
  //             higher lot on five (trueComp) vs ham; NOT a thin cut. Goal: ret closer to P2, DD <= P1+few.
  // P5 Triple: P2 + stocks OP8
  // P6 Whale: max OP/lot
  const portfolios = [
    {
      id: 'P1', setKey: 'portfolio-conservative-jul2026', label: 'Portfolio Conservative',
      character: 'WEEX HAM4+FIVE4 thin OP/lot + stocksZZ',
      storefront: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 4, op: 8, lot: 10, ri: 100, initial: 5000 },
        { key: 'five', n: 4, op: 6, lot: 8, ri: 100, initial: 5000 },
        { key: 'stocks', op: 6, lot: 15, ri: 100, initial: 0 },
      ],
    },
    {
      id: 'P2', setKey: 'portfolio-balanced-jul2026', label: 'Portfolio Balanced',
      character: 'WEEX HAM8+FIVE7 + stocksZZ',
      storefront: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 8, op: 10, lot: 12, ri: 100, initial: 6000 },
        { key: 'five', n: 7, op: 8, lot: 10, ri: 100, initial: 4000 },
        { key: 'stocks', op: 6, lot: 15, ri: 100, initial: 0 },
      ],
    },
    {
      id: 'P3', setKey: 'portfolio-aggressive-jul2026', label: 'Portfolio Aggressive',
      character: 'WEEX modules, more gas + stocksZZ',
      storefront: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 8, op: 14, lot: 16, ri: 100, initial: 10000 },
        { key: 'five', n: 7, op: 10, lot: 12, ri: 100, initial: 5000 },
        { key: 'stocks', op: 6, lot: 15, ri: 100, initial: 0 },
      ],
    },
    {
      id: 'P4', setKey: 'portfolio-quality-tilt-jul2026', label: 'Portfolio Quality Tilt',
      character: 'QUALITY: full WEEX set, FIVE-heavy lot (trueComp), HAM quieter OP vs Balanced',
      storefront: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 8, op: 8, lot: 10, ri: 100, initial: 5000 },
        { key: 'five', n: 7, op: 10, lot: 14, ri: 100, initial: 7000 },
        { key: 'stocks', op: 6, lot: 15, ri: 100, initial: 0 },
      ],
    },
    {
      id: 'P5', setKey: 'portfolio-triple-zz-jul2026', label: 'Portfolio Triple',
      character: 'balanced WEEX + stocksZZ OP8',
      storefront: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 8, op: 10, lot: 12, ri: 100, initial: 6000 },
        { key: 'five', n: 7, op: 8, lot: 10, ri: 100, initial: 4000 },
        { key: 'stocks', op: 8, lot: 15, ri: 100, initial: 0 },
      ],
    },
    {
      id: 'P6', setKey: 'portfolio-whale-personal-jul2026', label: 'Portfolio Whale (personal)',
      character: 'max OP/lot WEEX + stocksZZ',
      storefront: false, personal: true,
      books: [
        { key: 'b3', initial: 10000 },
        { key: 'ham', n: 8, op: 16, lot: 18, ri: 100, initial: 12000 },
        { key: 'five', n: 7, op: 12, lot: 14, ri: 100, initial: 6000 },
        { key: 'stocks', op: 8, lot: 15, ri: 100, initial: 0 },
      ],
    },
  ];

  const results = [];
  for (const pf of portfolios) {
    const deposit = pf.books.filter((b) => b.key !== 'stocks').reduce((s, b) => s + (b.initial || 0), 0);
    for (const w of [
      { tag: 'full', from: DATE_FROM, to: DATE_TO },
      { tag: 'short', from: DATE_FROM_SHORT, to: DATE_TO },
    ]) {
      const base = pf.books.filter((b) => b.key !== 'stocks');
      const withS = pf.books;
      const mk = (books) => Object.assign(books.map((x) => ({ ...x })), { _from: w.from, _to: w.to });
      console.log(`\n=== ${pf.id} ${pf.label} ${w.tag} deposit=$${deposit} ===`);
      const core = await runShared(mk(base), deposit);
      console.log(`  NO stocks: ret=${core.ret}% dd=${core.dd}% tr=${core.trades} n=${core.n}`);
      const withStocks = await runShared(mk(withS), deposit);
      console.log(`  +stocks: ret=${withStocks.ret}% dd=${withStocks.dd}% tr=${withStocks.trades} n=${withStocks.n}`);
      results.push({
        id: pf.id, setKey: pf.setKey, label: pf.label, character: pf.character,
        window: w.tag, deposit, core, withStocks,
        deltaRet: +(withStocks.ret - core.ret).toFixed(2),
        deltaDd: +(withStocks.dd - core.dd).toFixed(2),
      });
    }
  }

  // Write recipe + legs + snaps from FULL+stocks
  const hamLegs = [];
  for (const h of hamPick) hamLegs.push(await exportLeg(db, h.id));
  const fiveLegs = [];
  for (const f of fivePick) fiveLegs.push(await exportLeg(db, f.id));
  const stockLegs = [];
  for (const id of stocks) stockLegs.push(await exportLeg(db, id));

  const recipes = {
    generatedAt: new Date().toISOString(),
    status: 'STAMP — WEEX apiTradingSymbols filtered HAM/FIVE',
    note: 'HAM/FIVE rebuilt for live WEEX allowlist. P4 = FIVE-heavy quality tilt (not thin cut).',
    weexAllowlistN: allow.size,
    sharedB3: {
      systemIdSource: 205,
      setKey: 'portfolio-b3-core-shared-jul2026',
      legs: b3Ids.length, op: 12, lot: 15, ri: 50, tierCbOnZzBreakout: true,
    },
    universes: {
      ham_zz_weex8: { from: 'ham', ids: hamPick.map((x) => x.id), symbols: hamPick.map((x) => x.symbol) },
      ham_zz_weex4: { from: 'ham', ids: hamPick.slice(0, 4).map((x) => x.id), symbols: hamPick.slice(0, 4).map((x) => x.symbol) },
      five_weex7: { from: 'five', ids: fivePick.map((x) => x.id), symbols: fivePick.map((x) => x.symbol) },
      five_weex4: { from: 'five', ids: fivePick.slice(0, 4).map((x) => x.id), symbols: fivePick.slice(0, 4).map((x) => x.symbol) },
      stocks_zz_4h_l30: {
        from: 'stocks', op: 6, lot: 15, ri: 100,
        apiSymbols: stockLegs.map((x) => x.base_symbol),
      },
    },
    portfolios: portfolios.map((pf) => ({
      id: pf.id,
      setKey: pf.setKey,
      label: pf.label,
      storefront: pf.storefront !== false,
      personal: Boolean(pf.personal),
      character: pf.character,
      books: pf.books.map((b) => {
        if (b.key === 'b3') return { key: 'b3', ref: 'sharedB3', initial: b.initial };
        if (b.key === 'ham') {
          const uni = b.n <= 4 ? 'ham_zz_weex4' : 'ham_zz_weex8';
          return {
            key: 'ham', universe: uni, op: b.op, lot: b.lot, ri: b.ri, initial: b.initial,
            tsTag: `ham-${uni}-op${b.op}-lot${b.lot}`,
          };
        }
        if (b.key === 'five') {
          const uni = b.n <= 4 ? 'five_weex4' : 'five_weex7';
          return {
            key: 'five', universe: uni, op: b.op, lot: b.lot, ri: b.ri, initial: b.initial,
            tsTag: `five-${uni}-op${b.op}-lot${b.lot}`,
          };
        }
        return {
          key: 'stocks', universe: 'stocks_zz_4h_l30', op: b.op, lot: b.lot, ri: b.ri, initial: b.initial || 0,
          tsTag: b.op === 8 ? 'stocks-zz-4h-l30-op8' : 'stocks-zz-4h-l30',
        };
      }),
    })),
    retireMasterPrefixes: [
      'ALGOFUND_MASTER::BTDD_D1::addon-mrs-wf-',
      'ALGOFUND_MASTER::BTDD_D1::addon-zz-top5-jul2026',
      'ALGOFUND_MASTER::BTDD_D1::addon-mrs-weex-stocks-shortma-jul2026',
      'ALGOFUND_MASTER::BTDD_D1::addon-ham-',
      'ALGOFUND_MASTER::BTDD_D1::addon-five-',
      'ALGOFUND_MASTER::BTDD_D1::addon-stocks-zz-',
    ],
  };

  // keep newly published addon names regeneratable; retire old tags too
  const snaps = {};
  for (const pf of portfolios) {
    const full = results.find((r) => r.id === pf.id && r.window === 'full');
    snaps[pf.id] = {
      ret: full.withStocks.ret,
      dd: full.withStocks.dd,
      pf: full.withStocks.pf,
      trades: full.withStocks.trades,
      retNoStocks: full.core.ret,
      ddNoStocks: full.core.dd,
      capital: full.deposit,
      method: 'shared_deposit_hamfive_weex_filter',
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      character: pf.character,
    };
  }

  fs.writeFileSync(RECIPE, JSON.stringify(recipes, null, 2));
  fs.writeFileSync(LEGS, JSON.stringify({ ham: hamLegs, five: fiveLegs, stocks: stockLegs }, null, 2));
  fs.writeFileSync(SNAPS, JSON.stringify(snaps, null, 2));
  fs.writeFileSync(path.join(OUT_DIR, 'six_hamfive_weex_bt.json'), JSON.stringify({
    generatedAt: new Date().toISOString(),
    hamPick, fivePick, results,
  }, null, 2));

  const lines = [
    '# Six portfolios — WEEX-filtered HAM/FIVE rebuild',
    '',
    `HAM: ${hamPick.map((x) => x.symbol).join(', ')}`,
    `FIVE: ${fivePick.map((x) => x.symbol).join(', ')}`,
    '',
    '| PF | Deposit | NO stocks | +stocks | Δret | ΔDD |',
    '|---|---:|---|---|---:|---:|',
    ...results.filter((r) => r.window === 'full').map((r) =>
      `| ${r.id} ${r.label} | $${r.deposit} | **${r.core.ret}% / ${r.core.dd}%** | **${r.withStocks.ret}% / ${r.withStocks.dd}%** | ${r.deltaRet} | ${r.deltaDd} |`),
    '',
    '## Short',
    '',
    '| PF | NO stocks | +stocks |',
    '|---|---|---|',
    ...results.filter((r) => r.window === 'short').map((r) =>
      `| ${r.id} | ${r.core.ret}% / ${r.core.dd}% | ${r.withStocks.ret}% / ${r.withStocks.dd}% |`),
  ];
  fs.writeFileSync(path.join(OUT_DIR, 'six_hamfive_weex_bt.md'), lines.join('\n'));
  console.log('\nWrote recipe/legs/snaps +', path.join(OUT_DIR, 'six_hamfive_weex_bt.md'));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

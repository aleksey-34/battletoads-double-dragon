#!/usr/bin/env node
/**
 * Staggered-join portfolio BT: B3 + MRS (+ZZ) run the full window, the WEEX stocks
 * sleeve only exists from the date all 8 legs have candles (2026-06-17) and joins
 * the equity sum there, holding its $5000 as idle cash before that.
 *
 * This is deliberately NOT a percentage splice of the sleeve's short-window return
 * onto the long window — the sleeve's capital sits in the portfolio from t0 and
 * earns nothing until its legs exist.
 *
 *   node scripts/hybrid/research_staggered_stocks_portfolio_aug2026.cjs
 *
 * Env: DATE_FROM, DATE_TO, STOCKS_JOIN, PORTFOLIOS (comma set_key filter)
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const HAM_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const RECIPE = path.join(REPO, 'scripts/hybrid/portfolio_six_data_jul2026/recipes.json');
const WF = path.join(HAM_DIR, 'weex_mrs_engine_wf_postfill.json');
const OUT_DIR = path.join(REPO, 'results/stocks_hf_research_aug2026');
const OUT = path.join(OUT_DIR, 'staggered_portfolio_bt.json');
const OUT_MD = path.join(OUT_DIR, 'staggered_portfolio_bt.md');

const FLAT_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');
const HAM_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const STOCK_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_stocks_merged');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');

const KEY = 'BTDD_D1';
const B3_SYSTEM_ID = Number(process.env.B3_SYSTEM_ID || 205);
// Crypto (B3/MRS) candles stop 2026-07-16; stocks run to 2026-07-30. Cut both at the
// crypto edge so no book flatlines while another keeps trading.
const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || '2026-07-16';
const DATE_FROM_SHORT = process.env.DATE_FROM_SHORT || '2026-03-19';
const STOCKS_JOIN = process.env.STOCKS_JOIN || '2026-06-17';

const STOCK_LEG_PATTERN = 'HFSTOCK::BOOK_4h_s0.2_live8%';
const STOCK_OP = 6;
const STOCK_LOT = 15;
const STOCK_RI = 100;
const STOCK_INITIAL = 5000;

/** Sleeve fill assumptions. Maker is the optimistic engine default; taker is the stress floor. */
const STOCK_COSTS = [
  { tag: 'maker', comm: 0.036, slip: 0 },
  { tag: 'taker_stress', comm: 0.1, slip: 0.02 },
];

const TIER_CB = {
  enabled: true, peakWindowDays: 30, ddTriggerPercent: 8,
  lotMultiplier: 0.5, pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const hasCandle = (bundle, iv, sym) => fs.existsSync(path.join(bundle, iv, `${sym}.json`));
const toSec = (d) => Math.floor(new Date(`${d}T00:00:00Z`).getTime() / 1000);

const ensureMerged = () => {
  ensureDir(MERGED);
  for (const src of [FLAT_BUNDLE, HAM_BUNDLE, STOCK_BUNDLE]) {
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

const equitySeries = (curve) => {
  const out = [];
  for (const pt of curve || []) {
    const t = Number(pt.time || pt.t || pt.ts || 0);
    const e = Number(pt.equity ?? pt.value ?? pt.balance ?? NaN);
    if (Number.isFinite(t) && Number.isFinite(e)) out.push({ t, e });
  }
  return out.sort((a, b) => a.t - b.t);
};

/**
 * Equity sum where a book may start late: before its first sample it contributes
 * its full initial capital (idle cash), so portfolio capital is constant from t0.
 */
const combineStaggered = (books) => {
  const maps = books.map((b) => new Map(b.series.map((p) => [p.t, p])));
  const times = [...new Set(books.flatMap((b) => b.series.map((p) => p.t)))].sort((a, b) => a - b);
  const last = books.map((b) => b.initial);
  let peak = books.reduce((a, b) => a + b.initial, 0);
  let maxDd = 0;
  const curve = [];
  for (const t of times) {
    let eq = 0;
    for (let i = 0; i < books.length; i += 1) {
      const p = maps[i].get(t);
      if (p) last[i] = p.e;
      eq += last[i];
    }
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ t, e: eq });
  }
  const capital = books.reduce((a, b) => a + b.initial, 0);
  const final = curve.length ? curve[curve.length - 1].e : capital;
  return {
    ret: +(((final / capital) - 1) * 100).toFixed(2),
    dd: +maxDd.toFixed(2),
    final: +final.toFixed(2),
    capital,
    curve,
  };
};

const downsample = (arr, maxPts = 160) => {
  if (!arr?.length || arr.length <= maxPts) return arr || [];
  const step = Math.ceil(arr.length / maxPts);
  const out = [];
  for (let i = 0; i < arr.length; i += step) out.push(arr[i]);
  if (out[out.length - 1] !== arr[arr.length - 1]) out.push(arr[arr.length - 1]);
  return out;
};

const upsertMrs = async (db, leg, tag) => {
  const name = `PF6::MRS::${tag}::${leg.symbol}::${leg.tf}`;
  const existing = await db.get(
    `SELECT id FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name=?) AND name=?`,
    [KEY, name],
  );
  const p = leg.params || {};
  const lot = 6;
  const mrs2 = JSON.stringify({
    maLongLen: p.maLongLen ?? 5,
    maLongMult: p.maLongMult ?? 0.95,
    maShortLen: p.maShortLen ?? 5,
    maShortMult: p.maShortMult ?? 1.05,
    maCloseLongLen: p.maCloseLongLen ?? 5,
    maCloseLongMult: p.maCloseLongMult ?? 1,
    maCloseShortLen: p.maCloseShortLen ?? 5,
    maCloseShortMult: p.maCloseShortMult ?? 1,
    distanceFilterPct: p.distanceFilterPct ?? 0.3,
    slLongPct: p.slLongPct ?? 0,
    slShortPct: 0,
  });
  if (existing?.id) {
    await db.run(
      `UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
        price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
        mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
        reinvest_percent=100, market_mode='mono', market_type='futures',
        is_archived=0, updated_at=CURRENT_TIMESTAMP WHERE id=?`,
      [leg.symbol, leg.tf, p.maLongLen || 5, p.maLongMult || 0.95, p.maShortMult || 1.05,
        p.distanceFilterPct || 0.3, mrs2, lot, lot, existing.id],
    );
    return Number(existing.id);
  }
  const api = await db.get('SELECT id FROM api_keys WHERE name=?', [KEY]);
  const r = await db.run(
    `INSERT INTO strategies (
      name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
      price_channel_length, detection_source, take_profit_percent,
      zscore_entry, zscore_exit, zscore_stop,
      long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
      reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
      is_active, is_archived, is_runtime, origin, created_at, updated_at
    ) VALUES (?,?, 'MeanReversion', ?, '', ?, ?, 'wick', 0, ?,?,?,1,1,20,?,?,100,500000,'mono','futures',?,0,0,0,'research',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [name, api.id, leg.symbol, leg.tf, p.maLongLen || 5, p.maLongMult || 0.95,
      p.maShortMult || 1.05, p.distanceFilterPct || 0.3, lot, lot, mrs2],
  );
  return Number(r.lastID);
};

const runBook = async (runBacktest, ids, opts) => runBacktest({
  apiKeyName: KEY,
  mode: 'portfolio',
  strategyIds: ids,
  dateFrom: opts.from,
  dateTo: opts.to,
  bars: 14000,
  warmupBars: 120,
  initialBalance: opts.initial,
  commissionPercent: opts.comm,
  slippagePercent: opts.slip,
  maxOpenPositions: opts.op,
  lotPercentOverride: opts.lot,
  reinvestPercentOverride: opts.ri,
  maxDepositOverride: opts.initial * 50,
  enablePairLock: true,
  skipMissingSymbols: true,
  portfolioCircuitBreaker: opts.cb || null,
});

const main = async () => {
  ensureMerged();
  ensureDir(OUT_DIR);
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  const durable = wf.durable || wf.cloud || [];
  if (durable.length < 20) throw new Error(`WF durable too small: ${durable.length}`);

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  const only = (process.env.PORTFOLIOS || 'portfolio-conservative-jul2026,portfolio-balanced-jul2026,portfolio-aggressive-jul2026')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const targets = recipes.portfolios.filter((p) => only.includes(p.setKey));
  if (!targets.length) throw new Error('no portfolios matched PORTFOLIOS filter');

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
  console.log(`B3 ids=${b3Ids.length} durable=${durable.length} stockLegs=${stockIds.length}`);
  if (stockIds.length !== 8) console.warn(`WARN expected 8 stock legs, got ${stockIds.length}`);

  const mrsCache = new Map();
  for (const n of [20, 25, 30]) {
    const ids = [];
    for (const leg of durable.slice(0, n)) {
      if (!hasCandle(MERGED, leg.tf, leg.symbol)) continue;
      ids.push(await upsertMrs(db, leg, `N${n}`));
    }
    mrsCache.set(n, ids);
    console.log(`MRS N=${n} upserted ${ids.length}`);
  }

  const windows = [
    { tag: 'full', from: DATE_FROM, to: DATE_TO },
    { tag: 'short', from: DATE_FROM_SHORT, to: DATE_TO },
  ];

  // Stocks book depends only on the window end + cost model, so run it once per (window,cost).
  const stockRuns = new Map();
  for (const w of windows) {
    for (const c of STOCK_COSTS) {
      const key = `${w.tag}|${c.tag}`;
      const r = await runBook(runBacktest, stockIds, {
        from: STOCKS_JOIN, to: w.to, initial: STOCK_INITIAL,
        lot: STOCK_LOT, ri: STOCK_RI, op: STOCK_OP, comm: c.comm, slip: c.slip, cb: null,
      });
      const m = sum(r, STOCK_INITIAL);
      const series = equitySeries(r.equityCurve || []);
      console.log(`STOCKS ${key}: ret=${m.ret}% dd=${m.dd}% trades=${m.trades} pts=${series.length}`);
      stockRuns.set(key, { key: 'stocks', initial: STOCK_INITIAL, op: STOCK_OP, lot: STOCK_LOT, cost: c.tag, ...m, series });
    }
  }

  const results = [];
  for (const pf of targets) {
    for (const w of windows) {
      console.log(`\n=== ${pf.id} ${pf.label} ${w.tag} (${w.from}..${w.to}) ===`);
      const coreBooks = [];
      for (const book of pf.books) {
        if (book.key === 'b3') {
          const r = await runBook(runBacktest, b3Ids, {
            from: w.from, to: w.to, initial: book.initial,
            lot: recipes.sharedB3.lot, ri: recipes.sharedB3.ri, op: recipes.sharedB3.op,
            comm: 0.1, slip: 0.05, cb: TIER_CB,
          });
          const m = sum(r, book.initial);
          console.log(`  B3: ret=${m.ret}% dd=${m.dd}%`);
          coreBooks.push({ key: 'b3', initial: book.initial, ...m, series: equitySeries(r.equityCurve || []) });
        } else if (book.key === 'mrs') {
          const u = recipes.universes[book.universe];
          const n = u.n == null ? 30 : u.n;
          const ids = mrsCache.get(n) || mrsCache.get(30);
          const r = await runBook(runBacktest, ids, {
            from: w.from, to: w.to, initial: book.initial,
            lot: book.lot, ri: book.ri, op: book.op, comm: 0.036, slip: 0, cb: null,
          });
          const m = sum(r, book.initial);
          console.log(`  MRS n=${ids.length} OP${book.op}: ret=${m.ret}% dd=${m.dd}%`);
          coreBooks.push({ key: 'mrs', n: ids.length, initial: book.initial, op: book.op, lot: book.lot, ...m, series: equitySeries(r.equityCurve || []) });
        }
      }
      const core = combineStaggered(coreBooks);
      console.log(`  CORE (no stocks): ret=${core.ret}% dd=${core.dd}% cap=$${core.capital}`);

      const variants = {};
      for (const c of STOCK_COSTS) {
        const sb = stockRuns.get(`${w.tag}|${c.tag}`);
        const withStocks = combineStaggered([...coreBooks, sb]);
        variants[c.tag] = {
          capital: withStocks.capital,
          ret: withStocks.ret,
          dd: withStocks.dd,
          final: withStocks.final,
          deltaRet: +(withStocks.ret - core.ret).toFixed(2),
          deltaDd: +(withStocks.dd - core.dd).toFixed(2),
          stocksBook: { ret: sb.ret, dd: sb.dd, pf: sb.pf, trades: sb.trades, final: sb.final },
          curve: downsample(withStocks.curve),
        };
        console.log(`  +STOCKS(${c.tag}): ret=${withStocks.ret}% dd=${withStocks.dd}% cap=$${withStocks.capital} (Δret ${variants[c.tag].deltaRet})`);
      }

      results.push({
        window: w.tag,
        from: w.from,
        to: w.to,
        stocksJoin: STOCKS_JOIN,
        id: pf.id,
        setKey: pf.setKey,
        label: pf.label,
        core: {
          capital: core.capital,
          ret: core.ret,
          dd: core.dd,
          final: core.final,
          books: coreBooks.map(({ series, ...rest }) => rest),
          curve: downsample(core.curve),
        },
        withStocks: variants,
        method: 'per_book_equity_sum_with_delayed_join',
      });
    }
  }

  const stocksDays = Math.round((toSec(DATE_TO) - toSec(STOCKS_JOIN)) / 86400);
  const report = {
    generatedAt: new Date().toISOString(),
    status: 'RESEARCH ARTIFACT — not a production storefront stamp',
    method: 'per_book_equity_sum_with_delayed_join',
    methodNote: 'B3/MRS run the full window. Stocks $5000 sits as idle cash from t0 and joins the equity sum at stocksJoin, when all 8 WEEX legs have candles. No percentage splicing.',
    windows: windows.map((w) => `${w.tag}:${w.from}..${w.to}`),
    stocksJoin: STOCKS_JOIN,
    stocksParticipationDays: stocksDays,
    stocksLegs: stockIds.length,
    stocksConfig: { op: STOCK_OP, lot: STOCK_LOT, ri: STOCK_RI, initial: STOCK_INITIAL, tf: '4h', shiftPct: 0.2, source: STOCK_LEG_PATTERN },
    costModel: { b3: 'comm 0.1 / slip 0.05', mrs: 'comm 0.036 / slip 0', stocks: STOCK_COSTS },
    caveats: [
      'Crypto candles end 2026-07-16; window is cut there so no book flatlines.',
      `Stocks participate only ${stocksDays} days of the full window — Δret is structurally tiny and DD% falls mostly because idle capital enlarges the denominator.`,
      'Maker fills for the stocks sleeve are unverified (see path_accurate_rebaseline.md); taker_stress is the conservative floor.',
      'The July +47.15% sleeve figure is void and is not used anywhere here.',
    ],
    results,
  };
  fs.writeFileSync(OUT, JSON.stringify(report, null, 2));

  const rows = (tag) => results.filter((r) => r.window === tag).map((r) => {
    const mk = r.withStocks.maker;
    const tk = r.withStocks.taker_stress;
    return `| ${r.label} | $${r.core.capital} | ${r.core.ret} / ${r.core.dd} | $${mk.capital} | ${mk.ret} / ${mk.dd} | ${mk.deltaRet} / ${mk.deltaDd} | ${tk.ret} / ${tk.dd} |`;
  });
  const header = [
    '| Portfolio | Core cap | Core ret/DD % | Cap +stocks | Maker ret/DD % | Δ maker | Taker-stress ret/DD % |',
    '|---|---:|---|---:|---|---|---|',
  ];
  const md = [
    '# Staggered stocks join — portfolio BT (Aug 2026)',
    '',
    '**Status: research artifact — NOT a production storefront stamp.**',
    '',
    `Method: \`per_book_equity_sum_with_delayed_join\` · stocks join **${STOCKS_JOIN}** (~${stocksDays}d of participation) · sleeve OP${STOCK_OP} lot${STOCK_LOT} init $${STOCK_INITIAL}, 4h shift 0.2%, ${stockIds.length} legs`,
    '',
    `## Full window ${DATE_FROM} → ${DATE_TO}`,
    '',
    ...header,
    ...rows('full'),
    '',
    `## Short window ${DATE_FROM_SHORT} → ${DATE_TO}`,
    '',
    ...header,
    ...rows('short'),
    '',
    '## How to read this',
    '',
    `- The stocks book holds $${STOCK_INITIAL} as **idle cash** from day one and only starts trading at ${STOCKS_JOIN}.`,
    '- So on the full window it *dilutes* return per capital and shrinks DD% mostly by enlarging the denominator. Both effects are real for a client who funds the sleeve up front.',
    '- Maker fills are the optimistic bound. `taker_stress` is the floor. Path-accurate fill checks did not establish the sleeve edge — see `path_accurate_rebaseline.md`.',
    '- The July published sleeve number (+47.15%) is void and unused here.',
    '',
  ].join('\n');
  fs.writeFileSync(OUT_MD, md);
  console.log(`\nWrote ${OUT}`);
  console.log(`Wrote ${OUT_MD}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * Re-run P6 (Whale) card_full BT for equity curve stamp.
 * Recipe: B3 $10k OP12/lot15 + MRS top30 $20k OP20/lot10.
 *
 *   node scripts/hybrid/bt_portfolio_p6_curve_jul2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const DATA = path.join(__dirname, 'portfolio_six_data_jul2026');
const OUT_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const WF = path.join(OUT_DIR, 'weex_mrs_engine_wf_postfill.json');
const RECIPE = path.join(DATA, 'recipes.json');
const SNAPS = path.join(DATA, 'snapshots_card_full.json');
const FLAT_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');
const HAM_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');

const KEY = 'BTDD_D1';
const B3_SYSTEM_ID = Number(process.env.B3_SYSTEM_ID || 205);
const DATE_FROM = '2024-03-17';
const DATE_TO = '2026-07-15';
const TIER_CB = {
  enabled: true, peakWindowDays: 30, ddTriggerPercent: 8,
  lotMultiplier: 0.5, pauseDays: 14, applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });
const hasCandle = (bundle, iv, sym) => fs.existsSync(path.join(bundle, iv, `${sym}.json`));

const ensureMerged = () => {
  ensureDir(MERGED);
  for (const src of [FLAT_BUNDLE, HAM_BUNDLE]) {
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
    const u = Number(pt.unrealizedPnl ?? pt.unrealized ?? NaN);
    if (Number.isFinite(t) && Number.isFinite(e)) {
      out.push({ t, e, u: Number.isFinite(u) ? u : null });
    }
  }
  return out.sort((a, b) => a.t - b.t);
};

const combineBooks = (books) => {
  const maps = books.map((b) => new Map(b.series.map((p) => [p.t, p])));
  const times = [...new Set(books.flatMap((b) => b.series.map((p) => p.t)))].sort((a, b) => a - b);
  const last = books.map((b) => b.initial);
  const lastU = books.map(() => 0);
  let peak = books.reduce((a, b) => a + b.initial, 0);
  let maxDd = 0;
  const curve = [];
  const upnlCurve = [];
  for (const t of times) {
    let eq = 0;
    let up = 0;
    for (let i = 0; i < books.length; i += 1) {
      const p = maps[i].get(t);
      if (p) {
        last[i] = p.e;
        if (p.u != null) lastU[i] = p.u;
      }
      eq += last[i];
      up += lastU[i];
    }
    if (eq > peak) peak = eq;
    const dd = peak > 0 ? ((peak - eq) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ t, e: eq });
    upnlCurve.push({ t, u: up });
  }
  const capital = books.reduce((a, b) => a + b.initial, 0);
  const final = curve.length ? curve[curve.length - 1].e : capital;
  return {
    ret: +(((final / capital) - 1) * 100).toFixed(2),
    dd: +maxDd.toFixed(2),
    final: +final.toFixed(2),
    capital,
    curve,
    upnlCurve,
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
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const wf = fs.existsSync(WF)
    ? JSON.parse(fs.readFileSync(WF, 'utf8'))
    : JSON.parse(fs.readFileSync(path.join(DATA, 'mrs_wf_top30.json'), 'utf8'));
  const durable = wf.durable || wf.cloud || wf.legs || [];
  const legs = durable.slice(0, 30);
  if (legs.length < 30) throw new Error(`need 30 MRS legs, got ${legs.length}`);

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const db = database.db;

  const b3Rows = await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3_SYSTEM_ID],
  );
  const b3Ids = b3Rows.map((r) => Number(r.id));
  const mrsIds = [];
  for (const leg of legs) {
    if (!hasCandle(MERGED, leg.tf, leg.symbol)) {
      console.warn(`skip candle miss ${leg.symbol}:${leg.tf}`);
      continue;
    }
    mrsIds.push(await upsertMrs(db, leg, 'N30'));
  }
  console.log(`B3=${b3Ids.length} MRS=${mrsIds.length}`);

  const pf = recipes.portfolios.find((p) => p.id === 'P6');
  const b3Book = pf.books.find((b) => b.key === 'b3');
  const mrsBook = pf.books.find((b) => b.key === 'mrs');

  console.log('Running B3 book...');
  const b3r = await runBook(runBacktest, b3Ids, {
    from: DATE_FROM, to: DATE_TO, initial: b3Book.initial,
    lot: recipes.sharedB3.lot, ri: recipes.sharedB3.ri, op: recipes.sharedB3.op,
    comm: 0.1, slip: 0.05, cb: TIER_CB,
  });
  const b3m = sum(b3r, b3Book.initial);
  console.log(`B3 ret=${b3m.ret}% dd=${b3m.dd}%`);

  console.log('Running MRS book OP20 lot10...');
  const mrsr = await runBook(runBacktest, mrsIds, {
    from: DATE_FROM, to: DATE_TO, initial: mrsBook.initial,
    lot: mrsBook.lot, ri: mrsBook.ri, op: mrsBook.op,
    comm: 0.036, slip: 0, cb: null,
  });
  const mrsm = sum(mrsr, mrsBook.initial);
  console.log(`MRS ret=${mrsm.ret}% dd=${mrsm.dd}%`);

  const combined = combineBooks([
    { key: 'b3', initial: b3Book.initial, ...b3m, series: equitySeries(b3r.equityCurve || []) },
    { key: 'mrs', initial: mrsBook.initial, ...mrsm, series: equitySeries(mrsr.equityCurve || []) },
  ]);
  console.log(`TOTAL ret=${combined.ret}% dd=${combined.dd}% curve=${combined.curve.length}`);

  const snap = {
    ret: combined.ret,
    dd: combined.dd,
    capital: combined.capital,
    final: combined.final,
    method: 'p6_recipe_top30_op20_lot10_cap20k',
    curve: downsample(combined.curve),
    upnlCurve: downsample(combined.upnlCurve),
    books: [
      { key: 'b3', initial: b3Book.initial, ...b3m },
      { key: 'mrs', n: mrsIds.length, initial: mrsBook.initial, op: mrsBook.op, lot: mrsBook.lot, ...mrsm },
    ],
  };

  const snaps = JSON.parse(fs.readFileSync(SNAPS, 'utf8'));
  snaps.P6 = snap;
  fs.writeFileSync(SNAPS, JSON.stringify(snaps));
  const out = path.join(OUT_DIR, 'portfolio_p6_curve_jul2026.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), snap }, null, 2));
  console.log(`Updated ${SNAPS}`);
  console.log(`Wrote ${out}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * B3 × hamster system_89 cross research (honest portfolio BT).
 *
 * Designs:
 *   1) B3 baseline (tier CB, lot15/OP12/ri50)
 *   2) Hamster89 sleeve alone (OP12, lot~3 per leg)
 *   3) B3 + top MRS2 mono legs @ 0.25x / 0.5x lot mult
 *   4) B3 + top hamster ZZ mono legs @ 0.25x / 0.5x
 *   5) Dual-OP: two independent books, sum daily equity
 *   6) Keep/drop matrix vs baseline
 *
 * Env:
 *   DATE_FROM, DATE_TO, LONG=1 (also run extended window if candles allow)
 *   QUICK=1 — fewer hamster legs in sleeve (top 12 vs full available)
 *   SKIP_HEAVY=1 — skip full hamster sleeve + dual-op full grid
 *   DESIGNS=1,2,3 — comma list to run subset
 *
 * Usage:
 *   node scripts/hybrid/research_b3_x_hamster89_jul2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const OUT_FILE = path.join(OUT_DIR, 'b3_cross_results.json');
const FLAT_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');
const HAM_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
const MERGED_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const MAPPED = path.join(OUT_DIR, 'mapped_for_btdd.json');
const MRS2_PARAMS = path.join(OUT_DIR, 'mrs2_params.json');
const REPRODUCE = path.join(OUT_DIR, 'btdd_reproduce_results.json');
const PORTFOLIO_BT = path.join(OUT_DIR, 'portfolio_bt.json');
const OPTIMIZE_GRID = path.join(OUT_DIR, 'optimize_grid.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');

const DATE_FROM = process.env.DATE_FROM || '2026-04-01';
const DATE_TO = process.env.DATE_TO || '2026-07-12';
const DATE_FROM_LONG = process.env.DATE_FROM_LONG || '2024-06-01';
const RUN_LONG = String(process.env.LONG || '1') !== '0';
const QUICK = String(process.env.QUICK || '0') === '1';
const SKIP_HEAVY = String(process.env.SKIP_HEAVY || '0') === '1';
const DESIGN_FILTER = (process.env.DESIGNS || '').split(',').map((s) => s.trim()).filter(Boolean);

const INITIAL_B3 = Number(process.env.INITIAL_B3 || 10000);
const LOT_B3 = Number(process.env.LOT || 15);
const RI_B3 = Number(process.env.RI || 50);
const OP_B3 = Number(process.env.OP || 12);
const COMM_B3 = Number(process.env.COMM_B3 || 0.1);
const SLIP_B3 = Number(process.env.SLIP_B3 || 0.05);

const INITIAL_HAM = Number(process.env.INITIAL_HAM || 10000);
const LOT_HAM = Number(process.env.LOT_HAM || 3);
const OP_HAM = Number(process.env.OP_HAM || 12);
const COMM_HAM = Number(process.env.COMM_HAM || 0.036);
const SLIP_HAM = Number(process.env.SLIP_HAM || 0);

const B3_SYSTEM_ID = Number(process.env.B3_SYSTEM_ID || 205);

const TIER_CB = {
  enabled: true,
  peakWindowDays: 30,
  ddTriggerPercent: 8,
  lotMultiplier: 0.5,
  pauseDays: 14,
  applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

/** Symlink-merge flat_comp + hamster89 (hamster fills gaps). */
const ensureMergedBundle = () => {
  ensureDir(MERGED_BUNDLE);
  const sources = [FLAT_BUNDLE, HAM_BUNDLE];
  const intervals = new Set();
  for (const src of sources) {
    if (!fs.existsSync(src)) continue;
    for (const d of fs.readdirSync(src)) {
      if (fs.statSync(path.join(src, d)).isDirectory()) intervals.add(d);
    }
  }
  for (const iv of intervals) {
    const outIv = path.join(MERGED_BUNDLE, iv);
    ensureDir(outIv);
    for (const src of sources) {
      const dir = path.join(src, iv);
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        const dst = path.join(outIv, f);
        if (fs.existsSync(dst)) continue;
        const srcPath = path.join(dir, f);
        try {
          fs.symlinkSync(srcPath, dst);
        } catch {
          fs.copyFileSync(srcPath, dst);
        }
      }
    }
  }
  return MERGED_BUNDLE;
};

const hasCandle = (bundle, interval, symbol) =>
  fs.existsSync(path.join(bundle, interval, `${symbol}.json`));

const summarize = (result) => {
  const s = result.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    wr: +Number(s.winRatePercent || 0).toFixed(1),
    finalEquity: +Number(s.finalEquity || s.finalBalance || INITIAL_B3).toFixed(2),
    cbTriggers: +(s.portfolioCircuitBreakerTriggers || 0),
    skippedByPositionLimit: +(s.skippedByPositionLimit || 0),
  };
};

const equitySeries = (curve) => {
  const out = [];
  for (const pt of curve || []) {
    if (!pt || typeof pt !== 'object') continue;
    let t = Number(pt.time || pt.ts || 0);
    const e = Number(pt.equity || pt.value || 0);
    if (t > 0 && t < 1e12) t *= 1000;
    if (t > 0 && e > 0) out.push([t, e]);
  }
  out.sort((a, b) => a[0] - b[0]);
  return out;
};

const dailyEquity = (series) => {
  const byDay = new Map();
  for (const [t, e] of series) {
    byDay.set(new Date(t).toISOString().slice(0, 10), e);
  }
  return [...byDay.entries()].sort((a, b) => a[0].localeCompare(b[0]));
};

const combineDualBooks = (seriesA, seriesB, initialA, initialB) => {
  const daysA = new Map(dailyEquity(seriesA));
  const daysB = new Map(dailyEquity(seriesB));
  const days = [...new Set([...daysA.keys(), ...daysB.keys()])].sort();
  let eqA = initialA;
  let eqB = initialB;
  let peak = initialA + initialB;
  let maxDd = 0;
  const curve = [];
  for (const day of days) {
    if (daysA.has(day)) eqA = daysA.get(day);
    if (daysB.has(day)) eqB = daysB.get(day);
    const total = eqA + eqB;
    if (total > peak) peak = total;
    const dd = peak > 0 ? (peak - total) / peak : 0;
    if (dd > maxDd) maxDd = dd;
    curve.push({ day, equity: total, eqA, eqB });
  }
  const finalEquity = curve.length ? curve[curve.length - 1].equity : initialA + initialB;
  const ret = ((finalEquity / (initialA + initialB)) - 1) * 100;
  return {
    ret: +ret.toFixed(2),
    dd: +(maxDd * 100).toFixed(2),
    finalEquity: +finalEquity.toFixed(2),
    days: curve.length,
    curve: curve.filter((_, i, arr) => i % Math.max(1, Math.floor(arr.length / 120)) === 0 || i === arr.length - 1),
  };
};

const buildMrs2ConfigFromParams = (p, leg) => {
  const maLong = p?.ma_long || {};
  const maShort = p?.ma_short || {};
  const maCloseLong = p?.ma_close_long || {};
  const maCloseShort = p?.ma_close_short || {};
  return JSON.stringify({
    maLongLen: Number(maLong.len || leg.mrs_ma_len || 5),
    maLongMult: Number(maLong.multiplier || leg.mrs_mult_long || 0.95),
    maShortLen: Number(maShort.len || leg.mrs_ma_len || 5),
    maShortMult: Number(maShort.multiplier || leg.mrs_mult_short || 1.05),
    maCloseLongLen: Number(maCloseLong.len || leg.mrs_close_len || 5),
    maCloseLongMult: Number(maCloseLong.multiplier ?? 1.0),
    maCloseShortLen: Number(maCloseShort.len || leg.mrs_close_len || 5),
    maCloseShortMult: Number(maCloseShort.multiplier ?? 1.0),
    distanceFilterPct: Number(p?.distance_filter ?? leg.mrs_dist ?? 0.3),
    slLongPct: Number(leg.sl_long || 0),
    slShortPct: Number(leg.sl_short || leg.sl_long || 0),
  });
};

const upsertStrategy = async (db, draft) => {
  const existing = await db.get(
    `SELECT id FROM strategies
     WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
       AND name = ? LIMIT 1`,
    [draft.apiKeyName, draft.name],
  );
  const mrs2Json = draft.mrs2_config_json || '{}';
  const zEntry = draft.zscore_entry != null ? draft.zscore_entry : 2.0;
  const zExit = draft.zscore_exit != null ? draft.zscore_exit : 0.5;
  const zStop = draft.zscore_stop != null ? draft.zscore_stop : 3.5;
  const tp = draft.take_profit_percent != null ? draft.take_profit_percent : 0;
  const det = draft.detection_source || 'wick';

  if (existing?.id) {
    await db.run(
      `UPDATE strategies SET
         strategy_type=?, base_symbol=?, quote_symbol=?, interval=?,
         price_channel_length=?, detection_source=?, take_profit_percent=?,
         zscore_entry=?, zscore_exit=?, zscore_stop=?,
         long_enabled=1, short_enabled=1, leverage=?, lot_long_percent=?, lot_short_percent=?,
         reinvest_percent=?, max_deposit=?, market_mode='mono', market_type='futures',
         mrs2_config_json=?,
         is_active=0, is_archived=0, is_runtime=0, updated_at=CURRENT_TIMESTAMP
       WHERE id=?`,
      [
        draft.strategy_type, draft.symbol, '', draft.interval,
        draft.length, det, tp,
        zEntry, zExit, zStop,
        draft.leverage, draft.lot, draft.lot,
        draft.ri, draft.maxDeposit, mrs2Json, existing.id,
      ],
    );
    return Number(existing.id);
  }
  const api = await db.get('SELECT id FROM api_keys WHERE name = ?', [draft.apiKeyName]);
  if (!api?.id) throw new Error(`api key missing: ${draft.apiKeyName}`);
  const r = await db.run(
    `INSERT INTO strategies (
       name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
       price_channel_length, detection_source, take_profit_percent,
       zscore_entry, zscore_exit, zscore_stop,
       long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
       reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
       is_active, is_archived, is_runtime, origin, created_at, updated_at
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,?,?,?,?,?,0,0,0,'research',CURRENT_TIMESTAMP,CURRENT_TIMESTAMP)`,
    [
      draft.name, api.id, draft.strategy_type, draft.symbol, '', draft.interval,
      draft.length, det, tp,
      zEntry, zExit, zStop,
      draft.leverage, draft.lot, draft.lot,
      draft.ri, draft.maxDeposit, 'mono', 'futures', mrs2Json,
    ],
  );
  return Number(r.lastID);
};

const pickTopLegs = () => {
  const reproduce = fs.existsSync(REPRODUCE)
    ? JSON.parse(fs.readFileSync(REPRODUCE, 'utf8')).results || []
    : [];
  const zzRows = reproduce.filter((x) => x.kind === 'hamster_zz' && x.ret != null);
  const mrsRows = reproduce.filter((x) => x.kind === 'hamster_mrs2' && x.ret != null);

  const score = (x) => Number(x.ret || 0) - Number(x.dd || 0) * 0.35;
  const zzBalanced = zzRows
    .filter((x) => x.ret > 2 && x.dd < 15 && x.trades >= 7)
    .sort((a, b) => score(b) - score(a));
  const mrsBalanced = mrsRows
    .filter((x) => x.ret > 0.25 && x.dd < 3 && x.trades >= 20)
    .sort((a, b) => score(b) - score(a));

  const lynPath = path.join(OUT_DIR, 'lyn_btdd_compare.json');
  const lynFix = fs.existsSync(lynPath)
    ? JSON.parse(fs.readFileSync(lynPath, 'utf8'))
    : null;
  const lyn = lynFix?.after
    ? { symbol: 'LYNUSDT', tf: '3h', ret: lynFix.after.ret, dd: lynFix.after.dd, trades: lynFix.after.trades }
    : mrsRows.find((x) => x.symbol === 'LYNUSDT' && x.tf === '3h');
  const topMrsKeys = new Set();
  const topMrs = [];
  for (const row of [...(lyn ? [lyn] : []), ...mrsBalanced]) {
    const k = `${row.symbol}::${row.tf}`;
    if (topMrsKeys.has(k)) continue;
    topMrsKeys.add(k);
    topMrs.push(row);
    if (topMrs.length >= 6) break;
  }

  const topZz = zzBalanced.slice(0, 6);

  return { topMrs, topZz, zzRows, mrsRows };
};

const loadHamsterSleeveLegs = (mapped, mrs2BySet, bundle, quick) => {
  const included = fs.existsSync(PORTFOLIO_BT)
    ? JSON.parse(fs.readFileSync(PORTFOLIO_BT, 'utf8')).included || []
    : [];
  if (!quick && included.length >= 20 && !SKIP_HEAVY) {
    return { mode: 'portfolio_bt_ids', legs: included };
  }

  const { topMrs, topZz } = pickTopLegs();
  const keys = new Set([
    ...topMrs.map((x) => `${x.symbol}::${x.tf}::mrs2`),
    ...topZz.map((x) => `${x.symbol}::${x.tf}::zz`),
  ]);
  const legs = mapped.filter((leg) => {
    const k = `${leg.symbol}::${leg.tf}::${leg.strategy}`;
    if (!keys.has(k)) return false;
    return hasCandle(bundle, leg.tf, leg.symbol);
  });
  return { mode: quick ? 'top12_balanced' : 'top_balanced', legs, topMrs, topZz };
};

const upsertHamsterLeg = async (db, leg, mrs2BySet, keyName, lotOverride) => {
  const bundle = HAM_BUNDLE;
  if (!hasCandle(bundle, leg.tf, leg.symbol)) return null;
  const balPct = Number(lotOverride ?? leg.bal_pct ?? LOT_HAM);

  if (leg.strategy === 'zz') {
    const length = Math.max(2, Number(leg.zz6_len || leg.depth || 5));
    const stype = leg.our_type === 'ZZ_Fast' ? 'ZZ_Fast' : 'ZZ_Instance';
    const id = await upsertStrategy(db, {
      apiKeyName: keyName,
      name: `B3X::${stype}::${leg.symbol}::${leg.tf}::L${length}`,
      strategy_type: stype,
      symbol: leg.symbol,
      interval: leg.tf,
      length,
      leverage: Number(leg.leverage || 20),
      lot: balPct,
      ri: 100,
      maxDeposit: INITIAL_HAM * 50,
    });
    return {
      id, kind: 'zz', symbol: leg.symbol, tf: leg.tf, stype, lot: balPct,
      btdd_ret: leg.ret, btdd_dd: leg.dd,
    };
  }

  const full = mrs2BySet.get(leg.set);
  const mrs2Json = buildMrs2ConfigFromParams(full, leg);
  const cfg = JSON.parse(mrs2Json);
  const id = await upsertStrategy(db, {
    apiKeyName: keyName,
    name: `B3X::MRS2::${leg.symbol}::${leg.tf}::${leg.set}`,
    strategy_type: 'MRS2',
    symbol: leg.symbol,
    interval: leg.tf,
    length: cfg.maLongLen,
    detection_source: 'wick',
    take_profit_percent: 0,
    zscore_entry: cfg.maLongMult,
    zscore_exit: cfg.maShortMult,
    zscore_stop: cfg.distanceFilterPct,
    mrs2_config_json: mrs2Json,
    leverage: Number(leg.leverage || 20),
    lot: balPct,
    ri: 100,
    maxDeposit: INITIAL_HAM * 50,
  });
  return {
    id, kind: 'mrs2', symbol: leg.symbol, tf: leg.tf, lot: balPct,
    btdd_ret: leg.ret, btdd_dd: leg.dd,
  };
};

const legKeyFromMapped = (leg) => `${leg.symbol}::${leg.tf}::${leg.strategy}`;

const resolveAddonIds = async (db, mapped, mrs2BySet, addonLegs, lotMult, bundle) => {
  const reproduce = fs.existsSync(REPRODUCE)
    ? JSON.parse(fs.readFileSync(REPRODUCE, 'utf8')).results || []
    : [];
  const lynFix = fs.existsSync(path.join(OUT_DIR, 'lyn_btdd_compare.json'))
    ? JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'lyn_btdd_compare.json'), 'utf8'))
    : null;
  const byKey = new Map();
  for (const row of reproduce) {
    if (row.kind === 'hamster_zz') byKey.set(`${row.symbol}::${row.tf}::zz`, row);
    if (row.kind === 'hamster_mrs2') byKey.set(`${row.symbol}::${row.tf}::mrs2`, row);
  }
  if (lynFix?.after) {
    byKey.set('LYNUSDT::3h::mrs2', {
      symbol: 'LYNUSDT', tf: '3h', strategy: 'mrs2', ret: lynFix.after.ret, dd: lynFix.after.dd,
    });
  }

  const ids = [];
  const meta = [];
  for (const pick of addonLegs) {
    const key = `${pick.symbol}::${pick.tf}::${pick.strategy || (pick.kind === 'mrs2' ? 'mrs2' : 'zz')}`;
    let leg = mapped.find((x) => legKeyFromMapped(x) === key);
    if (!leg && pick.symbol) {
      leg = mapped.find((x) => x.symbol === pick.symbol && x.tf === pick.tf
        && x.strategy === (pick.strategy || pick.kind));
    }
    if (!leg) continue;
    if (!hasCandle(bundle, leg.tf, leg.symbol)) continue;
    const repro = byKey.get(legKeyFromMapped(leg)) || {};
    const info = await upsertHamsterLeg(db, { ...leg, ...repro }, mrs2BySet, 'BTDD_D1', LOT_HAM);
    if (!info) continue;
    ids.push(info.id);
    meta.push({
      ...info, lotMult, effectiveLotPct: +(LOT_B3 * lotMult).toFixed(3), hamster_pnl: leg.bt_pnl,
    });
  }
  return { ids, meta };
};

const runPortfolio = async (runBacktest, label, strategyIds, opts = {}) => {
  const {
    candleDir,
    dateFrom = DATE_FROM,
    dateTo = DATE_TO,
    initial = INITIAL_B3,
    lot = LOT_B3,
    ri = RI_B3,
    op = OP_B3,
    commission = COMM_B3,
    slippage = SLIP_B3,
    lotMultById = {},
    tierCb = TIER_CB,
    warmup = 120,
  } = opts;

  process.env.HYBRID_CANDLE_DIR = candleDir;
  const mul = {};
  for (const id of strategyIds) mul[String(id)] = Number(lotMultById[id] ?? 1);

  const payload = {
    apiKeyName: 'BTDD_D1',
    mode: 'portfolio',
    strategyIds,
    dateFrom,
    dateTo,
    bars: 9000,
    warmupBars: warmup,
    initialBalance: initial,
    commissionPercent: commission,
    slippagePercent: slippage,
    maxOpenPositions: op,
    lotPercentOverride: lot,
    reinvestPercentOverride: ri,
    maxDepositOverride: initial * Math.min(20, 1 + (ri / 100) * 19),
    lotPercentMultiplierByStrategyId: Object.keys(mul).length ? mul : undefined,
    enablePairLock: true,
    skipMissingSymbols: true,
    portfolioCircuitBreaker: tierCb,
  };

  const t0 = Date.now();
  const result = await runBacktest(payload);
  const m = summarize(result);
  m.elapsedSec = +((Date.now() - t0) / 1000).toFixed(1);
  m.label = label;
  m.legs = strategyIds.length;
  m.dateFrom = dateFrom;
  m.dateTo = dateTo;
  return { metrics: m, equity: equitySeries(result.equityCurve || []), result };
};

const verdict = (base, row) => {
  const dRet = +(row.ret - base.ret).toFixed(2);
  const dDd = +(row.dd - base.dd).toFixed(2);
  let action = 'DROP';
  if (dRet >= 1 && dDd <= 2) action = 'ADD';
  else if (dRet >= 0 && dDd <= 0.5) action = 'KEEP';
  else if (dRet >= 2 && dDd <= 5) action = 'ADD';
  else if (dRet < -1 || dDd > 3) action = 'DROP';
  else action = 'WATCH';
  return { action, dRet, dDd };
};

const wantDesign = (n) => !DESIGN_FILTER.length || DESIGN_FILTER.includes(String(n));

const main = async () => {
  ensureDir(OUT_DIR);
  const merged = ensureMergedBundle();
  console.log('merged candles:', merged);

  if (!fs.existsSync(MAPPED)) {
    throw new Error(`missing ${MAPPED} — run research_hamster_compound_system89_jul2026.cjs first`);
  }
  const mapped = JSON.parse(fs.readFileSync(MAPPED, 'utf8'));
  const mrs2BySet = new Map();
  if (fs.existsSync(MRS2_PARAMS)) {
    for (const row of JSON.parse(fs.readFileSync(MRS2_PARAMS, 'utf8'))) mrs2BySet.set(row.set, row);
  }

  let hamsterLot = LOT_HAM;
  let hamsterOp = OP_HAM;
  if (fs.existsSync(OPTIMIZE_GRID)) {
    try {
      const og = JSON.parse(fs.readFileSync(OPTIMIZE_GRID, 'utf8'));
      if (og.best?.lot) hamsterLot = Number(og.best.lot);
      if (og.best?.op) hamsterOp = Number(og.best.op);
      console.log('optimize_grid best lot/op', hamsterLot, hamsterOp);
    } catch { /* ignore */ }
  }

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const exchange = require(path.join(backendRoot, 'dist/bot/exchange'));
  const { clearHybridCandleCache } = require(path.join(backendRoot, 'dist/bot/hybridCandleStore'));

  await database.initDB();
  const { db } = database;
  try {
    await exchange.ensureExchangeClientInitialized('BTDD_D1');
  } catch (e) {
    console.warn('exchange init soft-fail:', e.message || e);
  }

  const key = await db.get('SELECT id FROM api_keys WHERE name = ?', ['BTDD_D1']);
  if (!key) {
    await db.run(
      `INSERT INTO api_keys (name, exchange, api_key, secret, passphrase)
       VALUES ('BTDD_D1', 'bybit', 'research', 'research', '')`,
    );
  }

  const coreRows = await db.all(`
    SELECT s.id, s.strategy_type, s.interval, s.base_symbol, s.quote_symbol, s.name
    FROM trading_system_members m
    JOIN strategies s ON s.id = m.strategy_id
    WHERE m.system_id = ? AND COALESCE(m.is_enabled, 1) = 1
    ORDER BY s.id
  `, [B3_SYSTEM_ID]);
  const core = coreRows.map((r) => Number(r.id));
  if (!core.length) throw new Error(`B3 system ${B3_SYSTEM_ID} has no members`);

  const { topMrs, topZz } = pickTopLegs();
  console.log('top MRS2', topMrs.map((x) => `${x.symbol}/${x.tf} ret=${x.ret}%`));
  console.log('top ZZ', topZz.map((x) => `${x.symbol}/${x.tf} ret=${x.ret}%`));

  const windows = [{ from: DATE_FROM, to: DATE_TO, tag: 'primary' }];
  if (RUN_LONG) windows.push({ from: DATE_FROM_LONG, to: DATE_TO, tag: 'long' });

  const allResults = [];

  for (const win of windows) {
    console.log(`\n======== WINDOW ${win.tag} ${win.from} -> ${win.to} ========`);
    const variants = [];
    let baseline = null;
    let hamsterSleeve = null;

    clearHybridCandleCache?.();

    if (wantDesign(1)) {
      console.log('\n--- D1 B3 baseline ---');
      const r = await runPortfolio(runBacktest, 'D1_B3_baseline', core, {
        candleDir: FLAT_BUNDLE,
        dateFrom: win.from,
        dateTo: win.to,
      });
      baseline = r;
      variants.push({ design: 1, ...r.metrics, detail: 'B3 only tier CB lot15/op12/ri50' });
      console.log(JSON.stringify(r.metrics));
    }

    if (wantDesign(2) && !SKIP_HEAVY) {
      console.log('\n--- D2 hamster89 sleeve ---');
      const sleeveSpec = loadHamsterSleeveLegs(mapped, mrs2BySet, HAM_BUNDLE, QUICK);
      let hamIds = [];
      let hamMeta = [];

      if (sleeveSpec.mode === 'portfolio_bt_ids') {
        hamIds = sleeveSpec.legs.map((x) => x.id);
        hamMeta = sleeveSpec.legs;
        console.log(`hamster sleeve from portfolio_bt: ${hamIds.length} legs`);
      } else {
        const keys = new Set([
          ...topMrs.map((x) => `${x.symbol}::${x.tf}::mrs2`),
          ...topZz.map((x) => `${x.symbol}::${x.tf}::zz`),
        ]);
        for (const leg of mapped) {
          if (!keys.has(legKeyFromMapped(leg))) continue;
          const info = await upsertHamsterLeg(db, leg, mrs2BySet, 'BTDD_D1', hamsterLot);
          if (info) {
            hamIds.push(info.id);
            hamMeta.push(info);
          }
        }
        console.log(`hamster sleeve upserted: ${hamIds.length} legs (${sleeveSpec.mode})`);
      }

      if (hamIds.length) {
        const r = await runPortfolio(runBacktest, 'D2_hamster89_sleeve', hamIds, {
          candleDir: HAM_BUNDLE,
          dateFrom: win.from,
          dateTo: win.to,
          initial: INITIAL_HAM,
          lot: hamsterLot,
          ri: 100,
          op: hamsterOp,
          commission: COMM_HAM,
          slippage: SLIP_HAM,
          tierCb: { enabled: false },
          warmup: 0,
        });
        hamsterSleeve = r;
        variants.push({
          design: 2,
          ...r.metrics,
          detail: `Hamster89 sleeve alone OP${hamsterOp} lot${hamsterLot} (${hamIds.length} legs)`,
          legsMeta: hamMeta.slice(0, 20),
        });
        console.log(JSON.stringify(r.metrics));

        // Optional full 80-leg reference when running quick top-12 sleeve
        if (QUICK && fs.existsSync(PORTFOLIO_BT) && wantDesign(2)) {
          const fullInc = JSON.parse(fs.readFileSync(PORTFOLIO_BT, 'utf8')).included || [];
          const fullIds = fullInc.map((x) => x.id).filter(Boolean);
          if (fullIds.length > hamIds.length) {
            console.log('\n--- D2b hamster89 full sleeve (reference) ---');
            const rf = await runPortfolio(runBacktest, 'D2b_hamster89_full_sleeve', fullIds, {
              candleDir: HAM_BUNDLE,
              dateFrom: win.from,
              dateTo: win.to,
              initial: INITIAL_HAM,
              lot: hamsterLot,
              ri: 100,
              op: hamsterOp,
              commission: COMM_HAM,
              slippage: SLIP_HAM,
              tierCb: { enabled: false },
              warmup: 0,
            });
            variants.push({
              design: '2b',
              ...rf.metrics,
              detail: `Full hamster89 OP${hamsterOp} lot${hamsterLot} (${fullIds.length} legs, OP-constrained)`,
              note: '9045+ skippedByPositionLimit expected with OP12 vs 80 legs',
            });
            console.log(JSON.stringify(rf.metrics));
          }
        }
      }
    }

    const addonRuns = [
      { design: 3, kind: 'mrs2', legs: topMrs, mults: [0.25, 0.5] },
      { design: 4, kind: 'zz', legs: topZz, mults: [0.25, 0.5] },
    ];

    for (const spec of addonRuns) {
      if (!wantDesign(spec.design)) continue;
      for (const mult of spec.mults) {
        const label = `D${spec.design}_B3_plus_${spec.kind}_x${mult}`;
        console.log(`\n--- ${label} ---`);
        const mappedLegs = spec.legs.map((x) => ({
          symbol: x.symbol,
          tf: x.tf,
          strategy: spec.kind,
          kind: spec.kind,
        }));
        const { ids: addonIds, meta } = await resolveAddonIds(
          db, mapped, mrs2BySet, mappedLegs, mult, merged,
        );
        if (!addonIds.length) {
          console.log('  skip — no addon ids');
          continue;
        }
        const lotMultById = Object.fromEntries([
          ...core.map((id) => [id, 1]),
          ...addonIds.map((id) => [id, mult]),
        ]);
        const r = await runPortfolio(runBacktest, label, [...core, ...addonIds], {
          candleDir: merged,
          dateFrom: win.from,
          dateTo: win.to,
          lotMultById,
        });
        variants.push({
          design: spec.design,
          lotMult: mult,
          kind: spec.kind,
          addonCount: addonIds.length,
          addons: meta,
          ...r.metrics,
          detail: `B3 + ${addonIds.length} ${spec.kind} mono @ ${mult}x (eff lot ${LOT_B3 * mult}%)`,
        });
        console.log(JSON.stringify(r.metrics));
      }
    }

    if (wantDesign(5) && baseline && hamsterSleeve) {
      console.log('\n--- D5 dual-OP (two books) ---');
      const dual = combineDualBooks(
        baseline.equity,
        hamsterSleeve.equity,
        INITIAL_B3,
        INITIAL_HAM,
      );
      const singleCombined = variants.find((v) => v.design === 3 && v.lotMult === 0.25)
        || variants.find((v) => v.design === 4 && v.lotMult === 0.25);
      variants.push({
        design: 5,
        label: 'D5_dual_op',
        ...dual,
        detail: `Independent OP: B3 $${INITIAL_B3} + Ham89 $${INITIAL_HAM}`,
        vs_single_op: singleCombined
          ? {
            single_label: singleCombined.label,
            single_ret: singleCombined.ret,
            single_dd: singleCombined.dd,
            dual_ret: dual.ret,
            dual_dd: dual.dd,
          }
          : null,
      });
      console.log(JSON.stringify({ dual_ret: dual.ret, dual_dd: dual.dd }));
    }

    if (wantDesign(6) && baseline) {
      console.log('\n--- D6 keep/drop matrix ---');
      const matrix = [];
      for (const v of variants) {
        if (v.design === 1 || v.design === 5 || v.design === 6) continue;
        const vd = verdict(baseline.metrics, v);
        matrix.push({
          label: v.label,
          design: v.design,
          ret: v.ret,
          dd: v.dd,
          ...vd,
          detail: v.detail,
        });
      }
      matrix.sort((a, b) => b.dRet - a.dRet);
      variants.push({ design: 6, label: 'keep_drop_matrix', matrix });
      for (const row of matrix) {
        console.log(`${row.action}\t${row.label}\tdRet=${row.dRet}\tdDd=${row.dDd}\tret=${row.ret}% dd=${row.dd}%`);
      }
    }

    allResults.push({
      window: win,
      b3_core: coreRows,
      baseline: baseline?.metrics || null,
      variants,
      topLegs: { mrs2: topMrs, zz: topZz },
    });
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    card: 'synth-stable-union-v4-4-b3-jul2026-wylwez',
    b3SystemId: B3_SYSTEM_ID,
    params: {
      b3: { initial: INITIAL_B3, lot: LOT_B3, ri: RI_B3, op: OP_B3, commission: COMM_B3 },
      hamster: { initial: INITIAL_HAM, lot: hamsterLot, op: hamsterOp, commission: COMM_HAM },
      tierCb: TIER_CB,
    },
    candles: { flat: FLAT_BUNDLE, hamster: HAM_BUNDLE, merged: MERGED_BUNDLE },
    optimizeGridUsed: fs.existsSync(OPTIMIZE_GRID),
    results: allResults,
    summaryRu: null,
  };

  // Russian summary
  const primary = allResults.find((r) => r.window.tag === 'primary') || allResults[0];
  const longWin = allResults.find((r) => r.window.tag === 'long');
  const base = primary?.baseline;
  const matrix = primary?.variants?.find((v) => v.design === 6)?.matrix || [];
  const dual = primary?.variants?.find((v) => v.design === 5);
  const ham = primary?.variants?.find((v) => v.design === 2);
  const hamFull = primary?.variants?.find((v) => v.design === '2b');
  const bestAdd = matrix.filter((x) => x.action === 'ADD').sort((a, b) => b.dRet - a.dRet)[0];
  const lines = [];
  lines.push('=== PRIMARY 2026-04-01..2026-07-12 ===');
  if (base) {
    lines.push(`KEEP B3 baseline: ret ${base.ret}%, maxDD ${base.dd}%, trades ${base.trades}, CB ${base.cbTriggers}×.`);
  }
  if (ham) {
    lines.push(`Hamster89 solo (top-12, OP12 lot3): ret ${ham.ret}%, DD ${ham.dd}%.`);
  }
  if (hamFull) {
    lines.push(`Hamster89 full 80 legs OP12: ret ${hamFull.ret}%, DD ${hamFull.dd}%, skippedByPosLimit ${hamFull.skippedByPositionLimit}.`);
  }
  if (bestAdd) {
    lines.push(`ADD: ${bestAdd.label} — dRet +${bestAdd.dRet}pp, dDD ${bestAdd.dDd}pp → ret ${bestAdd.ret}%, DD ${bestAdd.dd}%.`);
  }
  const keeps = matrix.filter((x) => x.action === 'KEEP');
  const drops = matrix.filter((x) => x.action === 'DROP');
  if (keeps.length) lines.push(`KEEP (marginal): ${keeps.map((x) => x.label).join(', ')}.`);
  if (drops.length) lines.push(`DROP: ${drops.map((x) => x.label).join(', ')}.`);
  if (dual) {
    lines.push(`Dual-OP (2×$10k): ret ${dual.ret}%, DD ${dual.dd}% vs single-OP B3+MRS2@0.25 ret ${dual.vs_single_op?.single_ret ?? 'n/a'}%.`);
  }
  if (longWin?.baseline) {
    const lm = longWin.variants?.find((v) => v.design === 6)?.matrix || [];
    const la = lm.filter((x) => x.action === 'ADD').sort((a, b) => b.dRet - a.dRet)[0];
    lines.push(`=== LONG ${DATE_FROM_LONG}..${DATE_TO} === B3 ret ${longWin.baseline.ret}% DD ${longWin.baseline.dd}%.`);
    if (la) lines.push(`Long-window ADD: ${la.label} dRet +${la.dRet}pp (MRS2 лучше ZZ на длинном окне).`);
  }
  payload.summaryRu = lines.join('\n');

  ensureDir(OUT_DIR);
  fs.writeFileSync(OUT_FILE, JSON.stringify(payload, null, 2));
  console.log('\n=== DONE ===');
  console.log('WROTE', OUT_FILE);
  console.log('\nRU:', payload.summaryRu);

  await database.closeDB?.();
  process.exit(0);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

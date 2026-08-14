#!/usr/bin/env node
/**
 * Re-run storefront P1–P5 with fear_union and stamp downsampled equity curves
 * into snapshots_hamfive_aug2026.json (fixes empty storefront sparkline).
 *
 *   node scripts/hybrid/stamp_portfolio_equity_curves_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const RECIPE = path.join(__dirname, 'portfolio_six_data_jul2026/recipes_hamfive_aug2026.json');
const SNAPS = path.join(__dirname, 'portfolio_six_data_jul2026/snapshots_hamfive_aug2026.json');
const OUT_DIR = path.join(REPO, 'results/regime_risk_aug2026');
const SCHEDULE = path.join(OUT_DIR, 'fear_boost_schedules.json');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026');
const CRYPTO = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCKS = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
process.env.HYBRID_CANDLE_DIR = MERGED;
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const KEY = 'BTDD_D1';
const B3 = 205;
const DATE_FROM = '2024-03-17';
const DATE_TO = '2026-07-16';
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
};

const downsampleCurve = (curve, maxPts = 120) => {
  if (!Array.isArray(curve) || curve.length === 0) return [];
  if (curve.length <= maxPts) {
    return curve.map((p) => ({ t: Number(p.t ?? p.time), e: Number(p.e ?? p.equity) }))
      .filter((p) => Number.isFinite(p.t) && Number.isFinite(p.e));
  }
  const step = Math.ceil(curve.length / maxPts);
  const out = [];
  for (let i = 0; i < curve.length; i += step) {
    const p = curve[i];
    const t = Number(p.t ?? p.time);
    const e = Number(p.e ?? p.equity);
    if (Number.isFinite(t) && Number.isFinite(e)) out.push({ t, e: +e.toFixed(2) });
  }
  const last = curve[curve.length - 1];
  const lt = Number(last.t ?? last.time);
  const le = Number(last.e ?? last.equity);
  if (Number.isFinite(lt) && Number.isFinite(le)) {
    if (!out.length || out[out.length - 1].t !== lt) out.push({ t: lt, e: +le.toFixed(2) });
  }
  return out;
};

(async () => {
  ensureMerged();
  if (!fs.existsSync(SCHEDULE)) throw new Error(`missing ${SCHEDULE}`);
  const schedules = JSON.parse(fs.readFileSync(SCHEDULE, 'utf8'));
  const fearBoost = {
    enabled: true,
    lotMultiplier: schedules.lotMultiplier || 1.25,
    activeDayStartsMs: schedules.variants.fear_union.activeDayStartsMs,
  };
  const recipes = JSON.parse(fs.readFileSync(RECIPE, 'utf8'));
  const snaps = JSON.parse(fs.readFileSync(SNAPS, 'utf8'));

  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const { db } = database;

  const b3Ids = (await db.all(
    `SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
     WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1`,
    [B3],
  )).map((r) => Number(r.id));

  const uniCache = {};
  for (const [key, u] of Object.entries(recipes.universes || {})) {
    if (!u?.ids) { uniCache[key] = []; continue; }
    const out = [];
    for (const id of u.ids) {
      const row = await db.get(`SELECT id, interval, base_symbol FROM strategies WHERE id=?`, [id]);
      if (!row) continue;
      if (!hasCandle(MERGED, row.interval, row.base_symbol)) continue;
      out.push(Number(row.id));
    }
    uniCache[key] = out;
  }

  const mkBooks = (pf) => {
    const ids = [];
    const maxOpenPositionsByBook = {};
    const bookKeyByStrategyId = {};
    const lotPercentMultiplierByStrategyId = {};
    let maxRi = 0;
    let deposit = 0;
    for (const book of pf.books.filter((b) => b.key !== 'stocks')) {
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
      }
      if (!bookIds.length) continue;
      maxRi = Math.max(maxRi, ri || 0);
      deposit += Number(book.initial || 0);
      if (op > 0) maxOpenPositionsByBook[book.key] = op;
      for (const sid of bookIds) {
        ids.push(sid);
        bookKeyByStrategyId[String(sid)] = book.key;
        if (lot > 0) lotPercentMultiplierByStrategyId[String(sid)] = lot / 2;
      }
    }
    return {
      ids: [...new Set(ids)],
      maxOpenPositionsByBook,
      bookKeyByStrategyId,
      lotPercentMultiplierByStrategyId,
      maxRi,
      deposit,
    };
  };

  for (const pf of recipes.portfolios.filter((p) => p.storefront)) {
    const books = mkBooks(pf);
    console.log(`BT ${pf.id} n=${books.ids.length} dep=${books.deposit} ri=${books.maxRi}`);
    const r = await runBacktest({
      apiKeyName: KEY,
      mode: 'portfolio',
      strategyIds: books.ids,
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      bars: 14000,
      warmupBars: 120,
      skipMissingSymbols: true,
      initialBalance: books.deposit,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: 0,
      maxOpenPositionsByBook: books.maxOpenPositionsByBook,
      bookKeyByStrategyId: books.bookKeyByStrategyId,
      lotPercentOverride: 2,
      lotPercentMultiplierByStrategyId: books.lotPercentMultiplierByStrategyId,
      enablePairLock: true,
      maxDepositOverride: books.maxRi > 0 ? books.deposit * 50 : 0,
      reinvestPercentOverride: books.maxRi,
      portfolioCircuitBreaker: TIER_CB,
      researchLotSchedule: fearBoost,
    });
    const s = r.summary || {};
    const curve = downsampleCurve(r.equityCurve || [], 120);
    const prev = snaps[pf.id] || {};
    snaps[pf.id] = {
      ...prev,
      ret: +Number(s.totalReturnPercent || prev.ret || 0).toFixed(2),
      dd: +Number(s.maxDrawdownPercent || prev.dd || 0).toFixed(2),
      pf: +Number(s.profitFactor || prev.pf || 0).toFixed(3),
      trades: +(s.tradesCount || s.totalTrades || prev.trades || 0),
      capital: books.deposit,
      method: 'hamfive_cb_fear_union_ri100',
      dateFrom: DATE_FROM,
      dateTo: DATE_TO,
      curve,
    };
    console.log(`  ${pf.id}: ret=${snaps[pf.id].ret} dd=${snaps[pf.id].dd} curve=${curve.length}`);
  }

  fs.writeFileSync(SNAPS, JSON.stringify(snaps, null, 2));
  console.log('Wrote', SNAPS);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

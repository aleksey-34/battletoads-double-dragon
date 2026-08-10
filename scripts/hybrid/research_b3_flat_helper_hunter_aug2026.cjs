#!/usr/bin/env node
/**
 * B3 flat-helper hunter (Aug 2026)
 *
 * Goal: find strategies that make money specifically when B3 is underwater/flat,
 * while not destroying the book when trends resume (B3 will carry trends).
 *
 * Pipeline:
 *   1) B3 baseline → daily equity → UNDERWATER (dd>=8%) / TREND masks
 *   2) Solo-screen candidate pools → flatHelpScore
 *   3) Combo top singles + type baskets with B3 @ reduced lot
 *   4) Simple IS/OOS check on top combos
 *
 *   node scripts/hybrid/research_b3_flat_helper_hunter_aug2026.cjs
 *
 * Env: DATE_FROM, DATE_TO, QUICK=1 (smaller pools), TOP_N, ADDON_MULT
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/b3_flat_helper_hunter_aug2026');
const OUT = path.join(OUT_DIR, 'hunter.json');
const OUT_MD = path.join(OUT_DIR, 'hunter.md');
const CRYPTO_MERGED = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const FLAT_BUNDLE = path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || '2026-07-16';
const IS_TO = process.env.IS_TO || '2025-06-30';
const OOS_FROM = process.env.OOS_FROM || '2025-07-01';
const INITIAL = 10000;
const LOT = 15;
const RI = 50;
const OP_B3 = 12;
const OP_SOLO = 4;
const ADDON_MULT = Number(process.env.ADDON_MULT || 0.35);
const TOP_N = Number(process.env.TOP_N || 12);
const DD_FLAT = Number(process.env.DD_FLAT || 0.08);
const QUICK = process.env.QUICK === '1';

const TIER_CB = {
  enabled: true,
  peakWindowDays: 30,
  ddTriggerPercent: 8,
  lotMultiplier: 0.5,
  pauseDays: 14,
  applyToStrategyTypes: ['zz_breakout'],
};

const ensureDir = (p) => fs.mkdirSync(p, { recursive: true });

const pickBundle = () => {
  if (fs.existsSync(CRYPTO_MERGED)) {
    process.env.HYBRID_CANDLE_DIR = CRYPTO_MERGED;
    return CRYPTO_MERGED;
  }
  process.env.HYBRID_CANDLE_DIR = FLAT_BUNDLE;
  return FLAT_BUNDLE;
};

const summarize = (result) => {
  const s = result.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    wr: +Number(s.winRatePercent || 0).toFixed(1),
    finalEquity: +Number(s.finalEquity || s.finalBalance || INITIAL).toFixed(2),
    skippedOP: +(s.skippedByPositionLimit || 0),
  };
};

const equitySeries = (curve) => {
  const out = [];
  for (const pt of curve || []) {
    let t = Number(pt.time || pt.ts || pt.t || 0);
    const e = Number(pt.equity ?? pt.value ?? pt.balance ?? 0);
    if (t > 0 && t < 1e12) t *= 1000;
    if (t > 0 && e > 0) out.push([t, e]);
  }
  return out.sort((a, b) => a[0] - b[0]);
};

const dailyFromSeries = (series) => {
  if (series.length < 2) return [];
  const byDay = new Map();
  for (const [t, e] of series) {
    byDay.set(new Date(t).toISOString().slice(0, 10), e);
  }
  const days = [...byDay.keys()].sort();
  const out = [];
  for (let i = 1; i < days.length; i += 1) {
    const e0 = byDay.get(days[i - 1]);
    const e1 = byDay.get(days[i]);
    out.push({ day: days[i], ret: e1 / e0 - 1, equity: e1 });
  }
  return out;
};

/** Enrich B3 daily with peak/dd and regime tags. */
const enrichB3Daily = (daily, ddTrig = DD_FLAT) => {
  let peak = daily[0] ? daily[0].equity / (1 + daily[0].ret) : INITIAL;
  const rets = [];
  const out = [];
  for (const row of daily) {
    if (row.equity > peak) peak = row.equity;
    const dd = peak > 0 ? (peak - row.equity) / peak : 0;
    rets.push(row.ret);
    if (rets.length > 20) rets.shift();
    const roll20 = rets.reduce((a, b) => a + b, 0);
    let vol = 0;
    if (rets.length >= 5) {
      const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
      vol = Math.sqrt(rets.reduce((a, b) => a + (b - mean) ** 2, 0) / rets.length);
    }
    const underwater = dd >= ddTrig;
    const flatChop = !underwater && Math.abs(roll20) < 0.03 && vol > 0 && vol < 0.012;
    const trendUp = dd < 0.02 && roll20 > 0.04;
    out.push({
      ...row, dd, vol, roll20, underwater, flatChop, trendUp,
      helpMask: underwater || flatChop,
    });
  }
  return out;
};

const corr = (xs, ys) => {
  const n = Math.min(xs.length, ys.length);
  if (n < 8) return null;
  let sx = 0; let sy = 0; let sxx = 0; let syy = 0; let sxy = 0; let c = 0;
  for (let i = 0; i < n; i += 1) {
    const x = xs[i]; const y = ys[i];
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; c += 1;
  }
  if (c < 8) return null;
  const cov = sxy / c - (sx / c) * (sy / c);
  const vx = sxx / c - (sx / c) ** 2;
  const vy = syy / c - (sy / c) ** 2;
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
};

const compound = (rets) => {
  let e = 1;
  for (const r of rets) e *= (1 + r);
  return e - 1;
};

/** Score candidate vs B3 regimes. */
const scoreVsB3 = (candDailyMap, b3Daily, soloMetrics) => {
  const helpRets = [];
  const uwRets = [];
  const trendRets = [];
  const allAligned = [];
  const b3Help = [];
  const candHelp = [];
  for (const row of b3Daily) {
    const cr = candDailyMap.get(row.day);
    if (cr == null) continue;
    allAligned.push(cr);
    if (row.helpMask) {
      helpRets.push(cr);
      b3Help.push(row.ret);
      candHelp.push(cr);
    }
    if (row.underwater) uwRets.push(cr);
    if (row.trendUp || (!row.helpMask && row.dd < 0.02)) trendRets.push(cr);
  }
  const flatRet = compound(helpRets);
  const uwRet = compound(uwRets);
  const trendRet = compound(trendRets);
  const antiCorr = corr(b3Help.map((x) => -x), candHelp);
  // Primary: make money on B3-help days; tolerate some trend bleed (B3 carries).
  // Penalize catastrophic solo DD and negative help.
  const score =
    flatRet * 100
    + 0.35 * uwRet * 100
    - 0.25 * Math.max(0, -trendRet) * 100
    - 0.15 * Math.max(0, soloMetrics.dd - 25)
    + (antiCorr != null && antiCorr > 0 ? antiCorr * 5 : 0);
  // True compensator: profit on B3-flat, little/no need for trend days.
  // Extra-trend legs score high on `score` but low here.
  const trueComp =
    flatRet * 100
    + 0.5 * uwRet * 100
    - 0.4 * Math.max(0, trendRet) * 100 // punish riding the same trend as B3
    - 0.35 * Math.max(0, -trendRet) * 100 // still punish hard trend bleed
    - 0.2 * Math.max(0, soloMetrics.dd - 20)
    + (antiCorr != null && antiCorr > 0.05 ? antiCorr * 8 : 0);
  return {
    flatRetPct: +(flatRet * 100).toFixed(2),
    uwRetPct: +(uwRet * 100).toFixed(2),
    trendRetPct: +(trendRet * 100).toFixed(2),
    helpDays: helpRets.length,
    uwDays: uwRets.length,
    trendDays: trendRets.length,
    antiCorrHelp: antiCorr == null ? null : +antiCorr.toFixed(3),
    alignedDays: allAligned.length,
    score: +score.toFixed(3),
    trueCompScore: +trueComp.toFixed(3),
    profile: flatRet > 0 && trendRet <= flatRet * 0.5 ? 'compensator' : flatRet > 0 && trendRet > flatRet ? 'extra_trend' : flatRet <= 0 ? 'flat_drain' : 'mixed',
  };
};

const hasCandle = (bundle, iv, sym) => {
  if (!sym || sym === 'USDT' || sym === '-') return true;
  return fs.existsSync(path.join(bundle, iv, `${sym}.json`));
};

(async () => {
  const bundle = pickBundle();
  ensureDir(OUT_DIR);
  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  const exchange = require(path.join(backendRoot, 'dist/bot/exchange'));

  await database.initDB();
  const { db } = database;
  try { await exchange.ensureExchangeClientInitialized('BTDD_D1'); } catch (_) {}

  const run = async (ids, opts = {}) => {
    const mul = {};
    for (const id of ids) mul[String(id)] = Number((opts.mult || {})[id] ?? 1);
    return runBacktest({
      apiKeyName: 'BTDD_D1',
      mode: 'portfolio',
      strategyIds: ids,
      dateFrom: opts.from || DATE_FROM,
      dateTo: opts.to || DATE_TO,
      bars: 14000,
      warmupBars: 120,
      initialBalance: INITIAL,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: opts.op || (ids.length <= 2 ? OP_SOLO : OP_B3),
      lotPercentOverride: opts.lot || LOT,
      reinvestPercentOverride: opts.ri ?? RI,
      maxDepositOverride: INITIAL * Math.min(20, 1 + (RI / 100) * 19),
      lotPercentMultiplierByStrategyId: mul,
      enablePairLock: true,
      skipMissingSymbols: true,
      portfolioCircuitBreaker: opts.cb === false ? null : TIER_CB,
    });
  };

  const coreRows = await db.all(`
    SELECT s.id, s.strategy_type, s.interval, s.base_symbol, s.quote_symbol, s.name
    FROM trading_system_members m
    JOIN strategies s ON s.id = m.strategy_id
    WHERE m.system_id = 205 AND COALESCE(m.is_enabled, 1) = 1
    ORDER BY s.id`);
  const core = coreRows.map((r) => Number(r.id));
  const coreSet = new Set(core);
  if (!core.length) throw new Error('B3 system 205 empty');

  const loadMeta = async (ids) => {
    const out = {};
    for (const id of ids) {
      const r = await db.get(
        `SELECT id, name, strategy_type, interval, base_symbol, quote_symbol,
                take_profit_percent FROM strategies WHERE id=?`,
        [id],
      );
      if (r) out[id] = r;
    }
    return out;
  };

  const candleOk = (row) => {
    if (!row) return false;
    return hasCandle(bundle, row.interval, row.base_symbol)
      && hasCandle(bundle, row.interval, row.quote_symbol || '');
  };

  // ---- candidate pools ----
  const pools = {
    CT_Fractal: (await db.all(`SELECT id FROM strategies WHERE strategy_type='CT_Fractal' AND COALESCE(is_archived,0)=0`)).map((r) => +r.id),
    hideep: (await db.all(`SELECT id FROM strategies WHERE strategy_type='hideep' AND COALESCE(is_archived,0)=0`)).map((r) => +r.id),
    stat_arb: (await db.all(`SELECT id FROM strategies WHERE strategy_type='stat_arb_zscore' AND COALESCE(is_archived,0)=0`)).map((r) => +r.id),
    DD_TP: (await db.all(`SELECT id FROM strategies WHERE strategy_type='DD_BattleToads' AND COALESCE(is_archived,0)=0 AND COALESCE(take_profit_percent,0)>0 AND name NOT LIKE 'CHGRIND%'`)).map((r) => +r.id),
    MRS2_addon: (await db.all(`SELECT id FROM strategies WHERE name LIKE 'MRS2_B3ADDON%' AND COALESCE(is_archived,0)=0`)).map((r) => +r.id),
    PF6_MRS_N20: (await db.all(`SELECT id FROM strategies WHERE name LIKE 'PF6::MRS::N20::%' AND COALESCE(is_archived,0)=0`)).map((r) => +r.id),
    HAM_ZZ: (await db.all(`SELECT id FROM strategies WHERE name LIKE 'HAM89::%' AND COALESCE(is_archived,0)=0 AND id NOT IN (${core.join(',')}) LIMIT ${QUICK ? 10 : 20}`)).map((r) => +r.id),
  };
  if (QUICK) {
    pools.PF6_MRS_N20 = pools.PF6_MRS_N20.slice(0, 8);
    pools.stat_arb = pools.stat_arb.slice(0, 6);
  }

  const candidateIds = [...new Set(Object.values(pools).flat())].filter((id) => !coreSet.has(id));
  const meta = await loadMeta([...core, ...candidateIds]);
  const runnable = candidateIds.filter((id) => candleOk(meta[id]));
  console.log(`Bundle ${bundle}`);
  console.log(`DATE ${DATE_FROM}->${DATE_TO} B3=${core.length} candidates=${runnable.length}/${candidateIds.length}`);
  for (const [k, v] of Object.entries(pools)) {
    console.log(`  pool ${k}: ${v.filter((id) => runnable.includes(id)).length}/${v.length}`);
  }

  // ---- 1) B3 baseline ----
  console.log('\n=== B3 baseline ===');
  const t0 = Date.now();
  const b3Res = await run(core, { op: OP_B3 });
  const b3 = summarize(b3Res);
  const b3Eq = equitySeries(b3Res.equityCurve);
  const b3Daily = enrichB3Daily(dailyFromSeries(b3Eq));
  const helpDayCount = b3Daily.filter((d) => d.helpMask).length;
  const uwDayCount = b3Daily.filter((d) => d.underwater).length;
  console.log(JSON.stringify({ ...b3, helpDays: helpDayCount, uwDays: uwDayCount, elapsed: ((Date.now() - t0) / 1000).toFixed(1) }));

  // ---- 2) solo screen ----
  console.log('\n=== Solo screen ===');
  const solo = [];
  for (let i = 0; i < runnable.length; i += 1) {
    const id = runnable[i];
    const m = meta[id];
    const t1 = Date.now();
    let res;
    try {
      res = await run([id], { op: OP_SOLO, lot: LOT, cb: false });
    } catch (e) {
      console.log(`  FAIL ${id}: ${e.message || e}`);
      continue;
    }
    const metrics = summarize(res);
    const dailyMap = new Map(dailyFromSeries(equitySeries(res.equityCurve)).map((r) => [r.day, r.ret]));
    const vs = scoreVsB3(dailyMap, b3Daily, metrics);
    const pool = Object.entries(pools).find(([, ids]) => ids.includes(id))?.[0] || 'other';
    const row = {
      id,
      pool,
      type: m.strategy_type,
      interval: m.interval,
      pair: `${m.base_symbol}/${m.quote_symbol || '-'}`,
      name: m.name,
      ...metrics,
      ...vs,
      elapsedSec: +((Date.now() - t1) / 1000).toFixed(2),
    };
    solo.push(row);
    console.log(`[${i + 1}/${runnable.length}] ${pool} ${id} flat=${row.flatRetPct} uw=${row.uwRetPct} trend=${row.trendRetPct} solo=${row.ret}/${row.dd} score=${row.score}`);
  }
  solo.sort((a, b) => b.score - a.score);

  const positiveFlat = solo.filter((r) => r.flatRetPct > 0 && r.helpDays >= 30);
  const top = solo.filter((r) => r.score > 0 && r.flatRetPct > 0).slice(0, TOP_N);
  const topTrue = [...solo]
    .filter((r) => r.trueCompScore > 0 && r.flatRetPct > 0 && r.profile === 'compensator')
    .sort((a, b) => b.trueCompScore - a.trueCompScore)
    .slice(0, TOP_N);
  console.log('\nTOP by flatHelpScore:', top.map((t) => `${t.id}:${t.score}`).join(', ') || '(none)');
  console.log('TOP true compensators:', topTrue.map((t) => `${t.id}:${t.trueCompScore}`).join(', ') || '(none)');

  // ---- 3) combos with B3 ----
  console.log('\n=== Combos with B3 ===');
  const combos = [];
  const pushCombo = async (label, addonIds, mult = ADDON_MULT) => {
    if (!addonIds.length) return;
    const ids = [...core, ...addonIds];
    const mul = Object.fromEntries(addonIds.map((id) => [id, mult]));
    const t1 = Date.now();
    const res = await run(ids, { op: Math.min(20, OP_B3 + Math.ceil(addonIds.length / 2)), mult: mul });
    const metrics = summarize(res);
    const row = {
      label,
      addonIds,
      addonN: addonIds.length,
      mult,
      ...metrics,
      dRet: +(metrics.ret - b3.ret).toFixed(2),
      dDd: +(metrics.dd - b3.dd).toFixed(2),
      elapsedSec: +((Date.now() - t1) / 1000).toFixed(1),
    };
    combos.push(row);
    console.log(`  ${label}: ret=${row.ret} dd=${row.dd} dRet=${row.dRet} dDd=${row.dDd}`);
  };

  combos.push({
    label: 'B3_only', addonIds: [], addonN: 0, mult: 1, ...b3, dRet: 0, dDd: 0,
  });

  // type baskets of positive-flat members
  const byPoolPos = {};
  for (const r of positiveFlat) {
    (byPoolPos[r.pool] ||= []).push(r.id);
  }
  for (const [pool, ids] of Object.entries(byPoolPos)) {
    await pushCombo(`B3+${pool}_flatPos`, ids.slice(0, QUICK ? 4 : 8));
  }

  // top singles individually
  for (const t of top.slice(0, Math.min(8, top.length))) {
    await pushCombo(`B3+solo_${t.id}`, [t.id]);
  }

  // top-K book
  if (top.length >= 3) {
    await pushCombo(`B3+top3`, top.slice(0, 3).map((t) => t.id));
    await pushCombo(`B3+top6`, top.slice(0, 6).map((t) => t.id));
  }
  if (top.length >= 1) {
    await pushCombo(`B3+top${Math.min(TOP_N, top.length)}`, top.slice(0, TOP_N).map((t) => t.id));
  }
  // true compensator books (flat+ without riding B3 trend)
  if (topTrue.length >= 1) {
    await pushCombo('B3+trueComp_top3', topTrue.slice(0, 3).map((t) => t.id));
    if (topTrue.length >= 5) await pushCombo('B3+trueComp_top6', topTrue.slice(0, 6).map((t) => t.id));
    for (const t of topTrue.slice(0, 5)) {
      await pushCombo(`B3+true_${t.id}`, [t.id]);
    }
  }
  const compIds = positiveFlat.filter((r) => r.profile === 'compensator').slice(0, 8).map((r) => r.id);
  if (compIds.length) await pushCombo('B3+profile_compensators', compIds);

  // control: always-on PF6 MRS N20 @0.35 (the "commonwealth" thesis control)
  const mrsCtrl = pools.PF6_MRS_N20.filter((id) => runnable.includes(id)).slice(0, QUICK ? 8 : 20);
  if (mrsCtrl.length) await pushCombo('B3+PF6_MRS_N20_ctrl', mrsCtrl, 0.35);

  // prior July CT winners control
  const ctKnown = [242969, 242974].filter((id) => runnable.includes(id));
  if (ctKnown.length) await pushCombo('B3+CT_July_winners', ctKnown, 0.35);

  combos.sort((a, b) => (b.dRet - 0.8 * Math.max(0, b.dDd)) - (a.dRet - 0.8 * Math.max(0, a.dDd)));

  // ---- 4) IS/OOS on best 3 combos (excl baseline) ----
  console.log('\n=== IS/OOS ===');
  const wf = [];
  const bestCombos = combos.filter((c) => c.addonN > 0).slice(0, 3);
  // also baseline IS/OOS
  const windows = [
    { tag: 'IS', from: DATE_FROM, to: IS_TO },
    { tag: 'OOS', from: OOS_FROM, to: DATE_TO },
  ];
  for (const w of windows) {
    const base = summarize(await run(core, { from: w.from, to: w.to, op: OP_B3 }));
    wf.push({ label: 'B3_only', window: w.tag, from: w.from, to: w.to, ...base, dRet: 0, dDd: 0 });
    for (const c of bestCombos) {
      const mul = Object.fromEntries(c.addonIds.map((id) => [id, c.mult]));
      const m = summarize(await run([...core, ...c.addonIds], {
        from: w.from, to: w.to,
        op: Math.min(20, OP_B3 + Math.ceil(c.addonIds.length / 2)),
        mult: mul,
      }));
      wf.push({
        label: c.label, window: w.tag, from: w.from, to: w.to, ...m,
        dRet: +(m.ret - base.ret).toFixed(2),
        dDd: +(m.dd - base.dd).toFixed(2),
      });
      console.log(`  ${w.tag} ${c.label}: dRet=${m.ret - base.ret} dDd=${m.dd - base.dd}`);
    }
  }

  // ---- verdict heuristics ----
  const stampSafe = combos.filter((c) => c.addonN > 0 && c.dRet > 20 && c.dDd <= 3 && c.dd <= b3.dd + 3);
  const interesting = combos.filter((c) => c.addonN > 0 && c.dRet > 0 && c.dDd <= 5);
  const verdict = {
    thesisMrsCommonwealth: mrsCtrl.length
      ? (combos.find((c) => c.label === 'B3+PF6_MRS_N20_ctrl') || null)
      : null,
    stampSafeCandidates: stampSafe.map((c) => c.label),
    interestingCandidates: interesting.map((c) => ({ label: c.label, dRet: c.dRet, dDd: c.dDd })),
    bestCombo: combos.find((c) => c.addonN > 0) || null,
    topSoloFlatHelpers: top.slice(0, 10),
    topTrueCompensators: topTrue.slice(0, 10),
    profileCounts: solo.reduce((acc, r) => {
      acc[r.profile] = (acc[r.profile] || 0) + 1;
      return acc;
    }, {}),
    note: stampSafe.length
      ? 'Found addon(s) that lift ret without blowing DD — review OOS before any stamp.'
      : interesting.length
        ? 'Soft positives only — not stamp-ready; continue hunting / tune lot.'
        : 'No combo beat B3 on flat-help without hurting DD/ret. Commonwealth thesis not confirmed for these pools.',
  };

  const artifact = {
    generatedAt: new Date().toISOString(),
    status: 'RESEARCH — not a stamp / not live apply',
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    isTo: IS_TO,
    oosFrom: OOS_FROM,
    bundle,
    dbFile: process.env.DB_FILE,
    settings: { LOT, RI, OP_B3, ADDON_MULT, DD_FLAT, TOP_N, QUICK, mrs2SameBar: process.env.MRS2_BT_SAME_BAR_EXIT },
    b3,
    b3Regimes: {
      days: b3Daily.length,
      helpDays: helpDayCount,
      uwDays: uwDayCount,
      flatChopDays: b3Daily.filter((d) => d.flatChop).length,
      trendUpDays: b3Daily.filter((d) => d.trendUp).length,
      helpDayShare: +((helpDayCount / Math.max(1, b3Daily.length)) * 100).toFixed(1),
    },
    pools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.filter((id) => runnable.includes(id))])),
    solo,
    positiveFlatCount: positiveFlat.length,
    combos,
    walkForward: wf,
    verdict,
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  const md = [
    '# B3 flat-helper hunter (Aug 2026)',
    '',
    `Window \`${DATE_FROM}\` → \`${DATE_TO}\` · honest costs 0.1%/0.05% · addon mult ${ADDON_MULT}`,
    '',
    '## Verdict',
    '',
    verdict.note,
    '',
    `B3 baseline: **${b3.ret}%** / DD **${b3.dd}%** · help-days ${helpDayCount}/${b3Daily.length} (${artifact.b3Regimes.helpDayShare}%)`,
    '',
    '### Top solo flat helpers (any profile)',
    '',
    '| Rank | ID | Pool | Profile | Pair | Flat% | Trend% | Solo ret/DD | Score |',
    '|---:|---:|---|---|---|---:|---:|---|---:|',
    ...top.slice(0, 15).map((t, i) => `| ${i + 1} | ${t.id} | ${t.pool} | ${t.profile} | ${t.pair} | ${t.flatRetPct} | ${t.trendRetPct} | ${t.ret}/${t.dd} | ${t.score} |`),
    '',
    '### True compensators (flat+ without riding B3 trend)',
    '',
    '| Rank | ID | Pool | Pair | Flat% | Trend% | Solo ret/DD | trueComp |',
    '|---:|---:|---|---|---:|---:|---|---:|',
    ...topTrue.slice(0, 15).map((t, i) => `| ${i + 1} | ${t.id} | ${t.pool} | ${t.pair} | ${t.flatRetPct} | ${t.trendRetPct} | ${t.ret}/${t.dd} | ${t.trueCompScore} |`),
    '',
    '### Combos vs B3',
    '',
    '| Label | Ret% | DD% | ΔRet | ΔDD | Addons |',
    '|---|---:|---:|---:|---:|---:|',
    ...combos.slice(0, 20).map((c) => `| ${c.label} | ${c.ret} | ${c.dd} | ${c.dRet} | ${c.dDd} | ${c.addonN} |`),
    '',
    '### Walk-forward (top combos)',
    '',
    '| Label | Window | Ret% | DD% | ΔRet | ΔDD |',
    '|---|---|---:|---:|---:|---:|',
    ...wf.map((w) => `| ${w.label} | ${w.window} | ${w.ret} | ${w.dd} | ${w.dRet} | ${w.dDd} |`),
    '',
    `Full JSON: \`${OUT}\``,
  ];
  fs.writeFileSync(OUT_MD, md.join('\n'));
  console.log('\nWrote', OUT);
  console.log(verdict.note);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

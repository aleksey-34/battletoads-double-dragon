#!/usr/bin/env node
/**
 * No-MRS portfolio pack vs current Conserv (B3+MRS+stockMRS).
 * Uses flat-helper modules: HAM ZZ, FIVECARD MRS2 thin, stock ZZ/Donch (not stock MRS).
 *
 * Metrics: ret/DD/PF/trades + flat-coverage vs B3 underwater days.
 *
 *   node scripts/hybrid/research_b3_nomrs_portfolio_pack_aug2026.cjs
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
const OUT_DIR = path.join(REPO, 'results/b3_flat_helper_hunter_aug2026');
const OUT = path.join(OUT_DIR, 'nomrs_portfolio_pack.json');
const OUT_MD = path.join(OUT_DIR, 'nomrs_portfolio_pack.md');
const CRYPTO = path.join(REPO, 'results/hybrid_candle_bundle_b3_hamster89_merged');
const STOCKS = path.join(REPO, 'results/hybrid_candle_bundle_weex_stocks');
const MERGED = path.join(REPO, 'results/hybrid_candle_bundle_nomrs_pack_aug2026');
const WF = path.join(REPO, 'results/hamster_compound_system89_jul2026/weex_mrs_engine_wf_postfill.json');
const HUNTER = path.join(OUT_DIR, 'hunter.json');
const EXT = path.join(OUT_DIR, 'hunter_ext_p1.json');

process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
process.env.DB_FILE = process.env.DB_FILE || path.join(REPO, 'backend/database.db.flat_comp');
if (!process.env.MRS2_BT_SAME_BAR_EXIT) process.env.MRS2_BT_SAME_BAR_EXIT = 'block';

const KEY = 'BTDD_D1';
const DATE_FROM = process.env.DATE_FROM || '2024-03-17';
const DATE_TO = process.env.DATE_TO || '2026-07-16';
const IS_TO = '2025-06-30';
const OOS_FROM = '2025-07-01';
const DEPOSIT = Number(process.env.DEPOSIT || 20000);
const DD_FLAT = 0.08;

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

const summarize = (result) => {
  const s = result.summary || {};
  return {
    ret: +Number(s.totalReturnPercent || 0).toFixed(2),
    dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
    pf: +Number(s.profitFactor || 0).toFixed(3),
    trades: +(s.tradesCount || s.totalTrades || 0),
    wr: +Number(s.winRatePercent || 0).toFixed(1),
    final: +Number(s.finalEquity || s.finalBalance || DEPOSIT).toFixed(2),
    skippedOP: +(s.skippedByPositionLimit || 0),
  };
};

const equitySeries = (curve) => {
  const out = [];
  for (const pt of curve || []) {
    let t = Number(pt.time || pt.ts || pt.t || 0);
    const e = Number(pt.equity ?? pt.value ?? 0);
    if (t > 0 && t < 1e12) t *= 1000;
    if (t > 0 && e > 0) out.push([t, e]);
  }
  return out.sort((a, b) => a[0] - b[0]);
};

const dailyFromSeries = (series) => {
  const byDay = new Map();
  for (const [t, e] of series) byDay.set(new Date(t).toISOString().slice(0, 10), e);
  const days = [...byDay.keys()].sort();
  const out = [];
  for (let i = 1; i < days.length; i += 1) {
    const e0 = byDay.get(days[i - 1]);
    const e1 = byDay.get(days[i]);
    out.push({ day: days[i], ret: e1 / e0 - 1, equity: e1 });
  }
  return out;
};

const enrichUnderwater = (daily) => {
  let peak = daily[0] ? daily[0].equity / (1 + daily[0].ret) : DEPOSIT;
  return daily.map((row) => {
    if (row.equity > peak) peak = row.equity;
    const dd = peak > 0 ? (peak - row.equity) / peak : 0;
    return { ...row, dd, underwater: dd >= DD_FLAT };
  });
};

const compound = (rets) => {
  let e = 1;
  for (const r of rets) e *= (1 + r);
  return e - 1;
};

/** Flat-coverage of portfolio vs B3 daily path. */
const flatCoverage = (b3Daily, portDailyMap) => {
  const uw = b3Daily.filter((d) => d.underwater);
  let helped = 0;
  let hurt = 0;
  let bothNeg = 0;
  let portPos = 0;
  const portUwRets = [];
  const b3UwRets = [];
  const deltaRets = [];
  for (const row of uw) {
    const pr = portDailyMap.get(row.day);
    if (pr == null) continue;
    b3UwRets.push(row.ret);
    portUwRets.push(pr);
    const d = pr - row.ret;
    deltaRets.push(d);
    if (d > 0) helped += 1;
    else if (d < 0) hurt += 1;
    if (row.ret < 0 && pr < 0) bothNeg += 1;
    if (pr > 0) portPos += 1;
  }
  const n = deltaRets.length || 1;
  return {
    uwDaysAligned: deltaRets.length,
    helpDaySharePct: +((helped / n) * 100).toFixed(1),
    hurtDaySharePct: +((hurt / n) * 100).toFixed(1),
    portPositiveOnUwPct: +((portPos / n) * 100).toFixed(1),
    bothNegativePct: +((bothNeg / n) * 100).toFixed(1),
    b3UwCompoundPct: +(compound(b3UwRets) * 100).toFixed(2),
    portUwCompoundPct: +(compound(portUwRets) * 100).toFixed(2),
    uwLiftPct: +((compound(portUwRets) - compound(b3UwRets)) * 100).toFixed(2),
    avgDailyLiftBps: deltaRets.length
      ? +((deltaRets.reduce((a, b) => a + b, 0) / deltaRets.length) * 10000).toFixed(2)
      : 0,
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

(async () => {
  ensureMerged();
  ensureDir(OUT_DIR);
  const database = require(path.join(backendRoot, 'dist/utils/database'));
  const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
  await database.initDB();
  const { db } = database;

  const hunter = JSON.parse(fs.readFileSync(HUNTER, 'utf8'));
  const ext = JSON.parse(fs.readFileSync(EXT, 'utf8'));
  const hamIds = hunter.combos.find((c) => c.label === 'B3+HAM_ZZ_flatPos').addonIds;
  const trueCompIds = hunter.combos.find((c) => c.label === 'B3+trueComp_top3').addonIds;
  const fiveIds = ext.combos.find((c) => c.label === 'B3+FIVECARD_flatPos').addonIds;
  // FIVECARD without overlapping SCR duplicate of MRS2_addon if needed — keep as-is
  const fiveNoDrain = fiveIds.filter((id) => {
    const s = ext.solo.find((x) => x.id === id);
    return s && s.ret > 0 && s.flatRetPct > 0;
  });

  const b3Ids = (await db.all(`
    SELECT s.id FROM trading_system_members m JOIN strategies s ON s.id=m.strategy_id
    WHERE m.system_id=205 AND COALESCE(m.is_enabled,1)=1 ORDER BY s.id`)).map((r) => +r.id);

  // Current MRS N20 (live-like Conserv mrs book)
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  const durable = (wf.durable || wf.cloud || []).slice(0, 20);
  const mrsIds = [];
  for (const leg of durable) {
    if (!hasCandle(MERGED, leg.tf, leg.symbol)) continue;
    mrsIds.push(await upsertMrs(db, leg, 'N20'));
  }

  // Stocks ZZ 4h L30 (least-bad channel_grinder honest) — API symbols
  const stockZz = (await db.all(`
    SELECT id, base_symbol FROM strategies
    WHERE name LIKE 'CHGRIND::stocks_api::zz_breakout::%::4h::L30'
      AND COALESCE(is_archived,0)=0
    ORDER BY base_symbol`)).map((r) => ({ id: +r.id, sym: r.base_symbol }));
  const STOCK_API = new Set(['AMZNUSDT', 'AVGOUSDT', 'BABAUSDT', 'IBMUSDT', 'INTCUSDT', 'MUUSDT', 'NVDAUSDT', 'RIVNUSDT', 'SOXLUSDT', 'SPXUSDT', 'TSLAUSDT', 'UBERUSDT']);
  const stockZzIds = stockZz.filter((r) => STOCK_API.has(r.sym) && hasCandle(MERGED, '4h', r.sym)).map((r) => r.id);

  // Stocks DD 4h L30 twin
  const stockDdIds = (await db.all(`
    SELECT id, base_symbol FROM strategies
    WHERE name LIKE 'CHGRIND::stocks_api::DD_BattleToads::%::4h::L30'
      AND COALESCE(is_archived,0)=0`))
    .filter((r) => STOCK_API.has(r.base_symbol) && hasCandle(MERGED, '4h', r.base_symbol))
    .map((r) => +r.id);

  console.log(`B3=${b3Ids.length} HAM=${hamIds.length} TRUE=${trueCompIds.length} FIVE=${fiveIds.length} FIVE+ret=${fiveNoDrain.length}`);
  console.log(`MRS_N20=${mrsIds.length} stockZZ=${stockZzIds.length} stockDD=${stockDdIds.length}`);

  const run = async (ids, opts = {}) => {
    const mul = {};
    for (const id of ids) mul[String(id)] = Number((opts.mult || {})[id] ?? 1);
    return runBacktest({
      apiKeyName: KEY,
      mode: 'portfolio',
      strategyIds: ids,
      dateFrom: opts.from || DATE_FROM,
      dateTo: opts.to || DATE_TO,
      bars: 14000,
      warmupBars: 120,
      initialBalance: opts.initial || DEPOSIT,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: opts.op || 16,
      lotPercentOverride: opts.lot || 12,
      reinvestPercentOverride: opts.ri ?? 50,
      maxDepositOverride: (opts.initial || DEPOSIT) * 30,
      lotPercentMultiplierByStrategyId: mul,
      enablePairLock: true,
      skipMissingSymbols: true,
      portfolioCircuitBreaker: opts.cb === false ? null : TIER_CB,
    });
  };

  /** Shared-deposit style: one wallet, per-leg lot multipliers approximating books. */
  const buildMult = (spec) => {
    // spec: { b3:1, ham:0.35, five:0.35, mrs:0.5, stock:0.35 }
    const mult = {};
    for (const id of b3Ids) mult[id] = spec.b3 ?? 1;
    for (const id of hamIds) mult[id] = spec.ham ?? 0;
    for (const id of trueCompIds) mult[id] = spec.trueComp ?? 0;
    for (const id of fiveNoDrain) mult[id] = spec.five ?? 0;
    for (const id of mrsIds) mult[id] = spec.mrs ?? 0;
    for (const id of stockZzIds) mult[id] = spec.stockZz ?? 0;
    for (const id of stockDdIds) mult[id] = spec.stockDd ?? 0;
    return mult;
  };

  const variants = [
    {
      key: 'live_like_conserv',
      label: 'CURRENT-like: B3 + MRS N20 + (no stocks here)',
      note: 'Closest to Conserv core without stock MRS; MRS lot~0.5 of B3',
      ids: [...b3Ids, ...mrsIds],
      mult: buildMult({ b3: 1, mrs: 0.5 }),
      op: 20, lot: 12, ri: 50,
      hasMrs: true, hasStocks: false,
    },
    {
      key: 'b3_only',
      label: 'B3 only',
      note: 'Trend core alone',
      ids: [...b3Ids],
      mult: buildMult({ b3: 1 }),
      op: 12, lot: 15, ri: 50,
      hasMrs: false, hasStocks: false,
    },
    {
      key: 'b3_ham',
      label: 'B3 + HAM ZZ flat+ (no MRS)',
      note: 'Class A cross-sectional trend expansion',
      ids: [...b3Ids, ...hamIds],
      mult: buildMult({ b3: 1, ham: 0.35 }),
      op: 16, lot: 15, ri: 50,
      hasMrs: false, hasStocks: false,
    },
    {
      key: 'b3_truecomp',
      label: 'B3 + CLO/SCR/KAS trueComp',
      note: 'Hybrid: 1 ZZ + 2 thin MR legs',
      ids: [...b3Ids, ...trueCompIds],
      mult: buildMult({ b3: 1, trueComp: 0.35 }),
      op: 14, lot: 15, ri: 50,
      hasMrs: true, hasStocks: false, thinMrs: true,
    },
    {
      key: 'b3_fivecard',
      label: 'B3 + FIVECARD flat+ (thin MRS2)',
      note: 'Curated 8 MRS2 compensators, not N20 book',
      ids: [...b3Ids, ...fiveNoDrain],
      mult: buildMult({ b3: 1, five: 0.35 }),
      op: 16, lot: 15, ri: 50,
      hasMrs: true, hasStocks: false, thinMrs: true,
    },
    {
      key: 'b3_ham_five',
      label: 'B3 + HAM + FIVECARD (no fat MRS)',
      note: 'Trend expansion + thin MR sleeve',
      ids: [...new Set([...b3Ids, ...hamIds, ...fiveNoDrain])],
      mult: buildMult({ b3: 1, ham: 0.35, five: 0.35 }),
      op: 18, lot: 14, ri: 50,
      hasMrs: true, hasStocks: false, thinMrs: true,
    },
    {
      key: 'b3_ham_stockzz',
      label: 'B3 + HAM + stocks ZZ 4h L30 (no MRS)',
      note: 'No MRS anywhere; stocks = channel/ZZ module',
      ids: [...b3Ids, ...hamIds, ...stockZzIds],
      mult: buildMult({ b3: 1, ham: 0.35, stockZz: 0.35 }),
      op: 18, lot: 14, ri: 50,
      hasMrs: false, hasStocks: true,
    },
    {
      key: 'b3_ham_five_stockzz',
      label: 'B3 + HAM + FIVECARD + stocks ZZ',
      note: 'Full new pack; stocks still non-MRS',
      ids: [...new Set([...b3Ids, ...hamIds, ...fiveNoDrain, ...stockZzIds])],
      mult: buildMult({ b3: 1, ham: 0.35, five: 0.35, stockZz: 0.35 }),
      op: 20, lot: 12, ri: 50,
      hasMrs: true, hasStocks: true, thinMrs: true,
    },
    {
      key: 'b3_stockzz',
      label: 'B3 + stocks ZZ only (no MRS, no HAM)',
      note: 'Stress: stocks channel alone as addon',
      ids: [...b3Ids, ...stockZzIds],
      mult: buildMult({ b3: 1, stockZz: 0.35 }),
      op: 14, lot: 15, ri: 50,
      hasMrs: false, hasStocks: true,
    },
    {
      key: 'b3_ham_stockdd',
      label: 'B3 + HAM + stocks DD 4h L30',
      note: 'Alt stock module (Donchian)',
      ids: [...b3Ids, ...hamIds, ...stockDdIds],
      mult: buildMult({ b3: 1, ham: 0.35, stockDd: 0.35 }),
      op: 18, lot: 14, ri: 50,
      hasMrs: false, hasStocks: true,
    },
  ];

  // B3 baseline daily for coverage
  console.log('\nB3 path for coverage…');
  const b3Res = await run(b3Ids, { op: 12, lot: 15, ri: 50, initial: DEPOSIT, mult: buildMult({ b3: 1 }) });
  const b3Metrics = summarize(b3Res);
  const b3Daily = enrichUnderwater(dailyFromSeries(equitySeries(b3Res.equityCurve)));
  console.log('B3', b3Metrics, 'uwDays', b3Daily.filter((d) => d.underwater).length);

  const results = [];
  for (const v of variants) {
    console.log(`\n=== ${v.key} ===`);
    const t0 = Date.now();
    const res = await run(v.ids, {
      op: v.op, lot: v.lot, ri: v.ri, initial: DEPOSIT, mult: v.mult,
    });
    const m = summarize(res);
    const portDaily = dailyFromSeries(equitySeries(res.equityCurve));
    const portMap = new Map(portDaily.map((r) => [r.day, r.ret]));
    const cov = flatCoverage(b3Daily, portMap);
    const row = {
      ...v,
      ids: undefined,
      mult: undefined,
      legs: v.ids.length,
      metrics: m,
      vsB3: {
        dRet: +(m.ret - b3Metrics.ret).toFixed(2),
        dDd: +(m.dd - b3Metrics.dd).toFixed(2),
        dTrades: m.trades - b3Metrics.trades,
      },
      flatCoverage: cov,
      elapsedSec: +((Date.now() - t0) / 1000).toFixed(1),
      addonBreakdown: {
        b3: b3Ids.length,
        ham: v.ids.filter((id) => hamIds.includes(id)).length,
        trueComp: v.ids.filter((id) => trueCompIds.includes(id)).length,
        five: v.ids.filter((id) => fiveNoDrain.includes(id)).length,
        mrsN20: v.ids.filter((id) => mrsIds.includes(id)).length,
        stockZz: v.ids.filter((id) => stockZzIds.includes(id)).length,
        stockDd: v.ids.filter((id) => stockDdIds.includes(id)).length,
      },
    };
    results.push(row);
    console.log(JSON.stringify({
      key: v.key, ret: m.ret, dd: m.dd, trades: m.trades,
      dRet: row.vsB3.dRet, helpShare: cov.helpDaySharePct, uwLift: cov.uwLiftPct,
    }));
  }

  // IS/OOS for top no-fat-MRS variants
  const wfKeys = ['b3_only', 'b3_ham', 'b3_fivecard', 'b3_ham_five', 'b3_ham_stockzz', 'b3_ham_five_stockzz', 'live_like_conserv'];
  const walkForward = [];
  for (const w of [
    { tag: 'IS', from: DATE_FROM, to: IS_TO },
    { tag: 'OOS', from: OOS_FROM, to: DATE_TO },
  ]) {
    const base = summarize(await run(b3Ids, {
      from: w.from, to: w.to, op: 12, lot: 15, ri: 50, initial: DEPOSIT, mult: buildMult({ b3: 1 }),
    }));
    for (const key of wfKeys) {
      const v = variants.find((x) => x.key === key);
      if (!v) continue;
      const m = summarize(await run(v.ids, {
        from: w.from, to: w.to, op: v.op, lot: v.lot, ri: v.ri, initial: DEPOSIT, mult: v.mult,
      }));
      walkForward.push({
        key, window: w.tag, ...m,
        dRet: +(m.ret - base.ret).toFixed(2),
        dDd: +(m.dd - base.dd).toFixed(2),
      });
      console.log(`WF ${w.tag} ${key}: dRet=${m.ret - base.ret} dDd=${m.dd - base.dd}`);
    }
  }

  // Leg catalogs for the report
  const catalog = {
    hamZz: hamIds.map((id) => hunter.solo.find((s) => s.id === id)).filter(Boolean),
    trueComp: trueCompIds.map((id) => hunter.solo.find((s) => s.id === id)).filter(Boolean),
    fivecard: fiveNoDrain.map((id) => ext.solo.find((s) => s.id === id)).filter(Boolean),
    stockZzIds,
    stockDdIds,
    mrsN20Count: mrsIds.length,
  };

  const ranked = [...results].sort((a, b) => (b.metrics.ret - 0.8 * b.metrics.dd) - (a.metrics.ret - 0.8 * a.metrics.dd));
  const noFatMrs = results.filter((r) => !r.hasMrs || r.thinMrs);
  const pureNoMrs = results.filter((r) => !r.hasMrs);

  const artifact = {
    generatedAt: new Date().toISOString(),
    status: 'RESEARCH — portfolio pack comparison; NOT stamp / NOT live',
    dateFrom: DATE_FROM,
    dateTo: DATE_TO,
    deposit: DEPOSIT,
    b3Baseline: b3Metrics,
    b3UwDays: b3Daily.filter((d) => d.underwater).length,
    b3Days: b3Daily.length,
    catalog,
    results,
    rankedKeys: ranked.map((r) => r.key),
    bestPureNoMrs: pureNoMrs.sort((a, b) => b.metrics.ret - a.metrics.ret)[0]?.key,
    bestThinOrNoMrs: noFatMrs.sort((a, b) => (b.metrics.ret - 0.8 * b.metrics.dd) - (a.metrics.ret - 0.8 * a.metrics.dd))[0]?.key,
    walkForward,
  };
  fs.writeFileSync(OUT, JSON.stringify(artifact, null, 2));

  const md = [
    '# No-MRS portfolio pack vs current (Aug 2026)',
    '',
    `Window \`${DATE_FROM}\` → \`${DATE_TO}\` · shared deposit $${DEPOSIT} · honest 0.1/0.05 · MRS2 same-bar=block`,
    '',
    `B3 baseline: **${b3Metrics.ret}%** / DD **${b3Metrics.dd}%** / trades ${b3Metrics.trades} · underwater days **${artifact.b3UwDays}/${artifact.b3Days}**`,
    '',
    '## Variants',
    '',
    '| Key | Ret% | DD% | PF | Trades | ΔRet vs B3 | UW help% | UW lift% | MRS? | Stocks? |',
    '|---|---:|---:|---:|---:|---:|---:|---:|---|---|',
    ...results.map((r) => `| ${r.key} | ${r.metrics.ret} | ${r.metrics.dd} | ${r.metrics.pf} | ${r.metrics.trades} | ${r.vsB3.dRet} | ${r.flatCoverage.helpDaySharePct} | ${r.flatCoverage.uwLiftPct} | ${r.hasMrs ? (r.thinMrs ? 'thin' : 'fat') : 'no'} | ${r.hasStocks ? 'ZZ/DD' : 'no'} |`),
    '',
    '### Flat coverage legend',
    '- **UW help%**: share of B3-underwater days where portfolio daily ret > B3 daily ret',
    '- **UW lift%**: compound port−B3 over those underwater days',
    '',
    '## Walk-forward ΔRet vs B3',
    '',
    '| Key | Window | ΔRet | ΔDD | Ret | DD | Trades |',
    '|---|---|---:|---:|---:|---:|---:|',
    ...walkForward.map((w) => `| ${w.key} | ${w.window} | ${w.dRet} | ${w.dDd} | ${w.ret} | ${w.dd} | ${w.trades} |`),
    '',
    '## Module catalogs',
    '',
    '### HAM ZZ flat+ (Class A)',
    ...catalog.hamZz.map((s) => `- \`${s.id}\` ${s.pair} ${s.type} ${s.interval} flat=${s.flatRetPct}% trend=${s.trendRetPct}%`),
    '',
    '### trueComp (CLO+SCR+KAS)',
    ...catalog.trueComp.map((s) => `- \`${s.id}\` ${s.pair} ${s.type} ${s.interval} flat=${s.flatRetPct}% trend=${s.trendRetPct}%`),
    '',
    '### FIVECARD flat+ (positive solo)',
    ...catalog.fivecard.map((s) => `- \`${s.id}\` ${s.pair} ${s.interval} flat=${s.flatRetPct}% trend=${s.trendRetPct}% solo=${s.ret}/${s.dd}`),
    '',
    `JSON: \`${OUT}\``,
  ];
  fs.writeFileSync(OUT_MD, md.join('\n'));
  console.log('\nWrote', OUT);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

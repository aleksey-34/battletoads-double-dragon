#!/usr/bin/env node
/**
 * Quick screen: closed-bar MRS2-style mean-reversion on synthetic ratio pairs.
 *
 * Synth legs are market on exchange — cannot rest true limits on ratio price.
 * Proxy model (documented in output):
 *   - Bands: SMA(ohlc4, len) * mult on ratio OHLC (base/quote, same as BT synthetic.ts)
 *   - Signal bar i-1: long if low <= entryLong band; short if high >= entryShort band
 *   - Fill bar i: market at open (next bar after touch)
 *   - Exit: same next-bar rule when prior bar touches close-MA band
 *   - distanceFilterPct: |entry - closeMa| / closeMa * 100 >= threshold
 *
 * Compare vs mono MRS2 reference (hamster89 reproduce + mono proxy same window).
 *
 * Usage:
 *   node scripts/hybrid/research_mrs2_synth_screen_jul2026.cjs
 *   QUICK=1 node ...   # smaller grid
 */
const path = require('path');
const fs = require('fs');

const REPO = path.join(__dirname, '..', '..');
const OUT_DIR = path.join(REPO, 'results/hamster_compound_system89_jul2026');
const OUT_FILE = path.join(OUT_DIR, 'mrs2_synth_screen.json');
const BUNDLE = process.env.HYBRID_CANDLE_DIR
  || path.join(REPO, 'results/hybrid_candle_bundle_flat_comp');
const HAMSTER_BT = path.join(OUT_DIR, 'btdd_reproduce_results.json');

const DATE_FROM = process.env.DATE_FROM || '2025-01-01';
const DATE_TO = process.env.DATE_TO || '2026-07-15';
const INITIAL = Number(process.env.INITIAL || 1000);
const LOT_PCT = Number(process.env.LOT_PCT || 3);
const LEVERAGE = Number(process.env.LEVERAGE || 20);
/** Per-leg commission; synthetic doubles (two legs). */
const COMMISSION_LEG = Number(process.env.COMMISSION_LEG || 0.036);
const DIST_FILTER = Number(process.env.DIST_FILTER || 0.3);
const QUICK = String(process.env.QUICK || '0') === '1';

/** B3 / flat_comp liquid synth pairs (both legs in bundle). */
const SYNTH_PAIRS_4H = [
  ['ORDIUSDT', 'PYTHUSDT'],
  ['ATOMUSDT', 'DOTUSDT'],
  ['INJUSDT', 'GRTUSDT'],
  ['NEARUSDT', 'SEIUSDT'],
  ['LTCUSDT', 'BCHUSDT'],
  ['WLDUSDT', 'NEARUSDT'],
  ['JUPUSDT', 'WLDUSDT'],
  ['LINKUSDT', 'UNIUSDT'],
  ['PENDLEUSDT', 'EIGENUSDT'],
  ['INJUSDT', 'TIAUSDT'],
  ['SUIUSDT', 'SEIUSDT'],
  ['WLDUSDT', 'JUPUSDT'],
  ['ZENUSDT', 'ATOMUSDT'],
  ['NEARUSDT', 'FILUSDT'],
  ['MANTAUSDT', 'APTUSDT'],
];

const SYNTH_PAIRS_1H = [
  ['ORDIUSDT', 'PYTHUSDT'],
  ['ATOMUSDT', 'DOTUSDT'],
  ['INJUSDT', 'GRTUSDT'],
  ['NEARUSDT', 'SEIUSDT'],
  ['LTCUSDT', 'BCHUSDT'],
  ['WLDUSDT', 'NEARUSDT'],
  ['JUPUSDT', 'WLDUSDT'],
  ['SUIUSDT', 'SEIUSDT'],
  ['WLDUSDT', 'JUPUSDT'],
];

const MONO_BENCHMARK_SYMBOLS = [
  'ETHUSDT', 'SOLUSDT', 'BNBUSDT', 'DOGEUSDT', 'AVAXUSDT',
  'LINKUSDT', 'NEARUSDT', 'INJUSDT', 'ORDIUSDT', 'WLDUSDT',
];

const ohlc4 = (b) => (b.open + b.high + b.low + b.close) / 4;

const smaOhlc4At = (bars, endIndex, period) => {
  const len = Math.max(1, Math.floor(period));
  if (endIndex < len - 1 || endIndex < 0 || endIndex >= bars.length) return NaN;
  let sum = 0;
  for (let i = endIndex - len + 1; i <= endIndex; i += 1) sum += ohlc4(bars[i]);
  return sum / len;
};

const computeLevelsAt = (bars, index, params) => {
  const src = index - 1;
  if (src < 0) return null;
  const maOpenLong = smaOhlc4At(bars, src, params.maLongLen);
  const maOpenShort = smaOhlc4At(bars, src, params.maShortLen);
  const maCloseLong = smaOhlc4At(bars, src, params.maCloseLongLen);
  const maCloseShort = smaOhlc4At(bars, src, params.maCloseShortLen);
  if (![maOpenLong, maOpenShort, maCloseLong, maCloseShort].every((v) => Number.isFinite(v) && v > 0)) {
    return null;
  }
  const entryLong = maOpenLong * params.maLongMult;
  const entryShort = maOpenShort * params.maShortMult;
  const exitLong = maCloseLong * params.maCloseLongMult;
  const exitShort = maCloseShort * params.maCloseShortMult;
  const distLongPct = Math.abs(entryLong - exitLong) / exitLong * 100;
  const distShortPct = Math.abs(entryShort - exitShort) / exitShort * 100;
  return {
    entryLong,
    entryShort,
    exitLong,
    exitShort,
    distOkLong: distLongPct >= params.distanceFilterPct,
    distOkShort: distShortPct >= params.distanceFilterPct,
  };
};

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

const loadLegCandles = (symbol, interval) => {
  const fp = path.join(BUNDLE, interval, `${symbol}.json`);
  if (!fs.existsSync(fp)) return null;
  const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
  const rows = raw.candles || raw;
  return rows
    .map((r) => ({
      timeMs: num(Array.isArray(r) ? r[0] : r.time),
      open: num(Array.isArray(r) ? r[1] : r.open),
      high: num(Array.isArray(r) ? r[2] : r.high),
      low: num(Array.isArray(r) ? r[3] : r.low),
      close: num(Array.isArray(r) ? r[4] : r.close),
      volume: num(Array.isArray(r) ? r[5] : r.volume),
    }))
    .filter((c) => c.timeMs > 0 && c.open > 0 && c.close > 0)
    .sort((a, b) => a.timeMs - b.timeMs);
};

/** Ratio OHLC: (base/quote) — mirrors backend/src/bot/synthetic.ts buildSyntheticSubCandle. */
const buildSyntheticCandles = (baseSym, quoteSym, interval) => {
  const base = loadLegCandles(baseSym, interval);
  const quote = loadLegCandles(quoteSym, interval);
  if (!base?.length || !quote?.length) return null;
  const quoteByTime = new Map(quote.map((c) => [c.timeMs, c]));
  const out = [];
  for (const bc of base) {
    const qc = quoteByTime.get(bc.timeMs);
    if (!qc) continue;
    const qo = qc.open;
    const qh = qc.high;
    const ql = qc.low;
    const qc_ = qc.close;
    if (qo <= 0 || qh <= 0 || ql <= 0 || qc_ <= 0) continue;
    const open = bc.open / qo;
    const close = bc.close / qc_;
    const ratioHighLow = bc.high / ql;
    const ratioLowHigh = bc.low / qh;
    const high = Math.max(open, close, ratioHighLow, ratioLowHigh);
    const low = Math.min(open, close, ratioHighLow, ratioLowHigh);
    out.push({ timeMs: bc.timeMs, open, high, low, close });
  }
  return out.length ? out : null;
};

const sliceWindow = (bars, fromMs, toMs) => bars.filter((b) => b.timeMs >= fromMs && b.timeMs <= toMs);

/**
 * Closed-bar MRS proxy backtest on ratio candles.
 * Entry/exit: prior bar band touch → market fill at current bar open.
 */
const runClosedBarMrsProxy = (bars, params, opts = {}) => {
  const initial = opts.initial ?? INITIAL;
  const lotPct = opts.lotPct ?? LOT_PCT;
  const leverage = opts.leverage ?? LEVERAGE;
  const commissionRate = (opts.synthetic ? COMMISSION_LEG * 2 : COMMISSION_LEG) / 100;

  let equity = initial;
  let peak = initial;
  let maxDd = 0;
  let state = 'flat';
  let entryPrice = 0;
  let trades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const warmup = Math.max(params.maLongLen, params.maShortLen, params.maCloseLongLen) + 3;

  const closeTrade = (side, exitPx) => {
    const notional = equity * (lotPct / 100) * leverage;
    const fee = notional * commissionRate * 2;
    let pnl = 0;
    if (side === 'long') pnl = notional * (exitPx / entryPrice - 1) - fee;
    else pnl = notional * (entryPrice / exitPx - 1) - fee;
    equity += pnl;
    trades += 1;
    if (pnl > 0) { wins += 1; grossProfit += pnl; }
    else grossLoss += Math.abs(pnl);
    if (equity > peak) peak = equity;
    const dd = peak > 0 ? ((peak - equity) / peak) * 100 : 0;
    if (dd > maxDd) maxDd = dd;
    state = 'flat';
    entryPrice = 0;
  };

  for (let i = warmup; i < bars.length; i += 1) {
    const cur = bars[i];
    const prev = bars[i - 1];
    const lv = computeLevelsAt(bars, i - 1, params);
    if (!lv) continue;

    if (state === 'long') {
      const exitTouch = prev.high >= lv.exitLong;
      if (exitTouch && cur.open > 0) closeTrade('long', cur.open);
    } else if (state === 'short') {
      const exitTouch = prev.low <= lv.exitShort;
      if (exitTouch && cur.open > 0) closeTrade('short', cur.open);
    }

    if (state !== 'flat') continue;

    const longTouch = lv.distOkLong && prev.low <= lv.entryLong;
    const shortTouch = lv.distOkShort && prev.high >= lv.entryShort;
    if (!longTouch && !shortTouch) continue;
    if (longTouch && shortTouch) {
      const dLong = Math.abs(cur.open - lv.entryLong);
      const dShort = Math.abs(cur.open - lv.entryShort);
      if (dLong <= dShort) {
        state = 'long';
        entryPrice = cur.open;
      } else {
        state = 'short';
        entryPrice = cur.open;
      }
    } else if (longTouch) {
      state = 'long';
      entryPrice = cur.open;
    } else {
      state = 'short';
      entryPrice = cur.open;
    }
  }

  const ret = ((equity / initial) - 1) * 100;
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  return {
    ret: +ret.toFixed(2),
    dd: +maxDd.toFixed(2),
    trades,
    wins,
    wr: trades ? +((wins / trades) * 100).toFixed(1) : 0,
    pf: +pf.toFixed(3),
    end: +equity.toFixed(2),
  };
};

const buildGrid = () => {
  const lens = QUICK ? [4, 5] : [3, 4, 5, 6];
  const longMults = QUICK ? [0.95, 0.96] : [0.94, 0.95, 0.96, 0.97];
  const shortMults = QUICK ? [1.04, 1.05] : [1.03, 1.04, 1.05, 1.06];
  const closeLens = QUICK ? [4] : [3, 4, 5];
  const grid = [];
  for (const len of lens) {
    for (const lm of longMults) {
      for (const sm of shortMults) {
        for (const cl of closeLens) {
          grid.push({
            maLongLen: len,
            maLongMult: lm,
            maShortLen: len,
            maShortMult: sm,
            maCloseLongLen: cl,
            maCloseLongMult: 1.0,
            maCloseShortLen: cl,
            maCloseShortMult: 1.0,
            distanceFilterPct: DIST_FILTER,
          });
        }
      }
    }
  }
  return grid;
};

const scoreRow = (r) => r.ret - 0.5 * r.dd;

const loadMonoMrs2Reference = () => {
  if (!fs.existsSync(HAMSTER_BT)) return null;
  const j = JSON.parse(fs.readFileSync(HAMSTER_BT, 'utf8'));
  const rows = (j.results || []).filter((x) => x.kind === 'hamster_mrs2' && !x.error && !x.skip);
  rows.sort((a, b) => b.ret - a.ret);
  const rets = rows.map((x) => x.ret).sort((a, b) => a - b);
  const dds = rows.map((x) => x.dd).sort((a, b) => a - b);
  const mid = Math.floor(rets.length / 2);
  return {
    source: 'hamster89_btdd_reproduce',
    window: j.window,
    legs_ok: rows.length,
    top5: rows.slice(0, 5).map((x) => ({
      symbol: x.symbol, tf: x.tf, ret: x.ret, dd: x.dd, trades: x.trades, pf: x.pf,
    })),
    median: { ret: rets[mid], dd: dds[mid] },
    positive_legs: rets.filter((r) => r > 0).length,
    avg_ret: +(rets.reduce((a, b) => a + b, 0) / Math.max(1, rets.length)).toFixed(2),
  };
};

const main = () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const fromMs = Date.parse(`${DATE_FROM}T00:00:00Z`);
  const toMs = Date.parse(`${DATE_TO}T23:59:59Z`);
  const grid = buildGrid();
  const intervals = [
    { tf: '4h', pairs: SYNTH_PAIRS_4H },
    { tf: '1h', pairs: SYNTH_PAIRS_1H },
  ];

  console.log(`MRS2 synth screen | window ${DATE_FROM}..${DATE_TO} | grid=${grid.length} | bundle=${BUNDLE}`);

  const allRuns = [];
  const pairBest = [];

  for (const { tf, pairs } of intervals) {
    for (const [base, quote] of pairs) {
      const candlesAll = buildSyntheticCandles(base, quote, tf);
      if (!candlesAll?.length) {
        console.log(`  SKIP ${base}/${quote} ${tf}: no synth candles`);
        continue;
      }
      const candles = sliceWindow(candlesAll, fromMs, toMs);
      if (candles.length < 80) {
        console.log(`  SKIP ${base}/${quote} ${tf}: only ${candles.length} bars in window`);
        continue;
      }
      let best = null;
      for (const params of grid) {
        const m = runClosedBarMrsProxy(candles, params, { synthetic: true });
        const row = {
          pair: `${base}/${quote}`,
          interval: tf,
          params,
          ...m,
          score: scoreRow(m),
        };
        allRuns.push(row);
        if (!best || row.score > best.score) best = row;
      }
      if (best) {
        pairBest.push(best);
        console.log(
          `  ${best.pair} ${tf}: best ret=${best.ret}% dd=${best.dd}% trades=${best.trades} `
          + `len=${best.params.maLongLen} lm=${best.params.maLongMult} sm=${best.params.maShortMult}`,
        );
      }
    }
  }

  allRuns.sort((a, b) => b.score - a.score);
  pairBest.sort((a, b) => b.score - a.score);

  const topGlobal = allRuns.slice(0, 15);
  const profitable = allRuns.filter((r) => r.ret > 0);
  const strong = allRuns.filter((r) => r.ret > 2 && r.dd < 5 && r.trades >= 20);

  /** Mono proxy on same window with best-median synth params for apples-to-apples. */
  const medianParams = topGlobal[Math.floor(topGlobal.length / 2)]?.params || grid[0];
  const monoProxy = [];
  const hamsterBundle = path.join(REPO, 'results/hybrid_candle_bundle_hamster89');
  for (const sym of MONO_BENCHMARK_SYMBOLS) {
    for (const tf of ['4h', '1h']) {
      const fp = path.join(hamsterBundle, tf, `${sym}.json`);
      if (!fs.existsSync(fp)) continue;
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'));
      const bars = (raw.candles || [])
        .map((r) => ({
          timeMs: num(Array.isArray(r) ? r[0] : r.time),
          open: num(Array.isArray(r) ? r[1] : r.open),
          high: num(Array.isArray(r) ? r[2] : r.high),
          low: num(Array.isArray(r) ? r[3] : r.low),
          close: num(Array.isArray(r) ? r[4] : r.close),
        }))
        .filter((c) => c.timeMs > 0)
        .sort((a, b) => a.timeMs - b.timeMs);
      const win = sliceWindow(bars, fromMs, toMs);
      if (win.length < 80) continue;
      const m = runClosedBarMrsProxy(win, medianParams, { synthetic: false });
      monoProxy.push({ symbol: sym, interval: tf, params: medianParams, ...m, score: scoreRow(m) });
    }
  }
  monoProxy.sort((a, b) => b.score - a.score);

  const monoRef = loadMonoMrs2Reference();
  const synthBestMedian = {
    ret: pairBest.map((x) => x.ret).sort((a, b) => a - b)[Math.floor(pairBest.length / 2)] || 0,
    dd: pairBest.map((x) => x.dd).sort((a, b) => a - b)[Math.floor(pairBest.length / 2)] || 0,
    trades: pairBest.map((x) => x.trades).sort((a, b) => a - b)[Math.floor(pairBest.length / 2)] || 0,
  };
  const monoProxyMedian = monoProxy.length ? {
    ret: monoProxy.map((x) => x.ret).sort((a, b) => a - b)[Math.floor(monoProxy.length / 2)],
    dd: monoProxy.map((x) => x.dd).sort((a, b) => a - b)[Math.floor(monoProxy.length / 2)],
    trades: monoProxy.map((x) => x.trades).sort((a, b) => a - b)[Math.floor(monoProxy.length / 2)],
  } : null;

  const verdict = (() => {
    const posPairs = pairBest.filter((p) => p.ret > 0).length;
    const moderateDd = pairBest.filter((p) => p.ret > 0 && p.dd < 20);
    const beatsMonoMedian = synthBestMedian.ret > (monoProxyMedian?.ret ?? -999);
    const lowDd = synthBestMedian.dd < 15;
    const worth = posPairs >= 10 && moderateDd.length >= 4 && beatsMonoMedian && lowDd;
    return {
      worth_b3_sleeve: worth ? 'yes' : 'no',
      why: worth
        ? `${posPairs}/${pairBest.length} pairs profitable; ${moderateDd.length} with dd<20%; median ret ${synthBestMedian.ret}% beats mono-proxy ${monoProxyMedian?.ret}%.`
        : `Mixed: ${posPairs}/${pairBest.length} pairs profitable at in-sample best grid, but median dd ${synthBestMedian.dd}% too high (0 cells dd<5%). `
          + `Synth median ret ${synthBestMedian.ret}% ${beatsMonoMedian ? 'beats' : 'trails'} closed-bar mono-proxy ${monoProxyMedian?.ret ?? 'n/a'}% on same window; `
          + `mono hamster engine ref median ${monoRef?.median?.ret ?? 'n/a'}% (shorter window). High pair dispersion (top WLD/NEAR +88%, bottom ORDI -48%).`,
      metrics: {
        pairs_screened: pairBest.length,
        pairs_profitable_best: posPairs,
        pairs_profitable_dd_lt_20: moderateDd.length,
        strong_grid_cells: strong.length,
        synth_best_median: synthBestMedian,
        mono_proxy_median: monoProxyMedian,
        selective_candidates: moderateDd
          .sort((a, b) => b.score - a.score)
          .slice(0, 5)
          .map((x) => ({ pair: x.pair, interval: x.interval, ret: x.ret, dd: x.dd, trades: x.trades })),
      },
    };
  })();

  const out = {
    generatedAt: new Date().toISOString(),
    model: {
      name: 'closed_bar_mrs_proxy',
      assumptions: [
        'Ratio OHLC = base/quote per backend synthetic.ts (bar-level leg geometry).',
        'Signal on bar i-1: long if low <= SMA*mult_long; short if high >= SMA*mult_short.',
        'Fill on bar i at open (market next bar — no ratio limit orders).',
        'Exit: prior bar touches close-MA band → market exit next bar open.',
        'Commission: 2x per-leg rate (synthetic two-leg execution).',
        `distanceFilterPct=${DIST_FILTER}`,
      ],
    },
    window: { from: DATE_FROM, to: DATE_TO, initial: INITIAL, lot_pct: LOT_PCT, leverage: LEVERAGE },
    grid: { combos: grid.length, quick: QUICK },
    mono_mrs2_reference: monoRef,
    mono_proxy_same_window: {
      note: 'Closed-bar proxy on mono symbols with median top-synth params',
      params: medianParams,
      top5: monoProxy.slice(0, 5),
      median: monoProxyMedian,
    },
    synth_pair_best: pairBest,
    synth_top_global: topGlobal,
    synth_summary: {
      total_runs: allRuns.length,
      profitable_runs: profitable.length,
      strong_runs: strong.length,
      best: allRuns[0] || null,
    },
    verdict,
    summary_ru: verdict.worth_b3_sleeve === 'yes'
      ? `Синтетический MRS2-proxy на ratio-парах выглядит жизнеспособным: ${pairBest.filter((p) => p.ret > 0).length} из ${pairBest.length} пар в плюсе, медиана dd ${synthBestMedian.dd}%. Имеет смысл как лёгкий B3-sleeve.`
      : `Честный скрин: closed-bar MRS2 на synth ratio даёт разброс — топ-пары (WLD/NEAR, INJ/TIA) +50–88%, но медиана dd ${synthBestMedian.dd}% и половина пар в минусе. Как широкий B3-sleeve — нет (dd слишком высокий); точечно 2–3 decorr-пары с лотом 0.2–0.35× можно копнуть отдельно.`,
  };

  fs.writeFileSync(OUT_FILE, JSON.stringify(out, null, 2));
  console.log(`\nWrote ${OUT_FILE}`);
  console.log(`Verdict: ${verdict.worth_b3_sleeve} — ${verdict.why}`);
};

main();

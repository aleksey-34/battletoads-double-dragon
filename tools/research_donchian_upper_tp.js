#!/usr/bin/env node
/**
 * Standalone hypothesis research: alternative TP exit modes for DD_BattleToads.
 *
 * RUNTIME: production exits LONG when currentClose <= trailing_anchor*(1 - tp%/100).
 *          (anchor = max(prev_anchor, currentClose), monotonic from entry)
 *
 * HYPOTHESES we test here, head-to-head, on identical candle windows:
 *
 *   M0  baseline_trailing_tp        — current runtime behaviour (control)
 *   M1  donchian_mid_pullback       — exit when price returns to donchianCenter
 *                                     (the "mean reversion" exit, no trailing)
 *   M2  donchian_channel_target     — exit when price reaches
 *                                     entry + (donchianHigh - donchianLow) for LONG
 *                                     (one-channel-width fixed take-profit)
 *   M3  hybrid_trailing_OR_mid      — whichever triggers first (M0 OR M1)
 *
 * Donchian center / high / low values are computed at the bar of ENTRY and held
 * fixed for the duration of the trade (so M1/M2 are deterministic targets).
 *
 * The script does NOT touch the runtime. It loads candle data via the compiled
 * backend/dist/bot/exchange.js, then iterates bars locally.
 *
 * Usage examples:
 *   node tools/research_donchian_upper_tp.js --symbols=ORDIUSDT,SOLUSDT,ETHUSDT \
 *        --interval=1h --length=12 --tp=5 --source=close --bars=6000 \
 *        --apikey=BTDD_D1 --out=research_donchian_upper.csv
 *
 *   node tools/research_donchian_upper_tp.js --symbols=ORDIUSDT --interval=1h \
 *        --length=8,12,16 --tp=3,5,7.5 --source=close,wick --apikey=BTDD_D1
 */
const path = require('path');
const fs = require('fs');

const args = process.argv.slice(2);
const arg = (k, def) => {
  const f = args.find((a) => a.startsWith(`--${k}=`));
  return f ? f.split('=').slice(1).join('=') : def;
};

const APIKEY = arg('apikey', 'BTDD_D1');
const SYMBOLS = String(arg('symbols', 'ORDIUSDT')).split(',').map((s) => s.trim()).filter(Boolean);
const INTERVAL = arg('interval', '1h');
const LENGTHS = String(arg('length', '12')).split(',').map((s) => parseInt(s, 10)).filter((n) => n > 0);
const TPS = String(arg('tp', '5')).split(',').map((s) => parseFloat(s)).filter((n) => n > 0);
const SOURCES = String(arg('source', 'close')).split(',').map((s) => s.trim().toLowerCase()).filter((s) => s === 'close' || s === 'wick');
const BARS = parseInt(arg('bars', '6000'), 10);
const COMMISSION_PCT = parseFloat(arg('commission', '0.1'));
const SLIPPAGE_PCT = parseFloat(arg('slippage', '0.05'));
const INITIAL_BALANCE = parseFloat(arg('initial', '10000'));
const OUT = arg('out', 'research_donchian_upper.csv');

const DIST_EXCH = path.resolve(__dirname, '..', 'backend', 'dist', 'bot', 'exchange.js');
const DIST_DB = path.resolve(__dirname, '..', 'backend', 'dist', 'utils', 'database.js');
if (!fs.existsSync(DIST_EXCH) || !fs.existsSync(DIST_DB)) {
  console.error(`[fatal] backend/dist not built — run 'cd backend && npm run build' first`);
  process.exit(1);
}
// eslint-disable-next-line global-require, import/no-dynamic-require
const { initDB } = require(DIST_DB);
// eslint-disable-next-line global-require, import/no-dynamic-require
const { getMarketData, ensureExchangeClientInitialized } = require(DIST_EXCH);

const fmt = (n, d = 4) => Number.isFinite(n) ? n.toFixed(d) : '';
const round = (n, d = 4) => Math.round(n * 10 ** d) / 10 ** d;

// ── Donchian on bars[i-length .. i-1], EXCLUSIVE of current bar ────────────
const donchian = (bars, i, length, source) => {
  if (i < length) return null;
  let hi = -Infinity, lo = Infinity;
  for (let k = i - length; k < i; k++) {
    const b = bars[k];
    if (b.high > hi) hi = b.high;
    if (b.low < lo) lo = b.low;
  }
  return { high: hi, low: lo, center: (hi + lo) / 2 };
};

// ── Single-symbol backtest for one mode + params ───────────────────────────
const runOne = (bars, length, tpPct, source, mode) => {
  let state = 'flat';
  let entryPx = 0;
  let entryDch = null;
  let trailingAnchor = 0;
  let equity = INITIAL_BALANCE;
  let peakEquity = equity;
  let maxDD = 0;
  let trades = 0;
  let wins = 0;
  let grossProfit = 0;
  let grossLoss = 0;
  const COST = (COMMISSION_PCT + SLIPPAGE_PCT) / 100;

  for (let i = length; i < bars.length; i++) {
    const cur = bars[i];
    const dch = donchian(bars, i, length, source);
    if (!dch) continue;

    // Exit logic FIRST (so we don't double-trade in one bar)
    if (state === 'long') {
      let exitNow = false;
      let exitPx = cur.close;
      const trailingStop = trailingAnchor * (1 - tpPct / 100);
      const midTarget = entryDch.center;
      const channelTarget = entryPx + (entryDch.high - entryDch.low);

      if (mode === 'M0') {
        if (cur.close <= trailingStop) { exitNow = true; }
      } else if (mode === 'M1') {
        if (cur.low <= midTarget) { exitNow = true; exitPx = midTarget; }
      } else if (mode === 'M2') {
        if (cur.high >= channelTarget) { exitNow = true; exitPx = channelTarget; }
      } else if (mode === 'M3') {
        if (cur.low <= midTarget) { exitNow = true; exitPx = midTarget; }
        else if (cur.close <= trailingStop) { exitNow = true; }
      }

      if (exitNow) {
        const ret = (exitPx - entryPx) / entryPx - 2 * COST;
        const pnl = equity * ret;
        equity += pnl;
        if (pnl > 0) { wins++; grossProfit += pnl; } else { grossLoss += -pnl; }
        trades++;
        state = 'flat'; entryPx = 0; entryDch = null; trailingAnchor = 0;
      } else {
        if (cur.close > trailingAnchor) trailingAnchor = cur.close;
      }
    } else if (state === 'short') {
      let exitNow = false;
      let exitPx = cur.close;
      const trailingStop = trailingAnchor * (1 + tpPct / 100);
      const midTarget = entryDch.center;
      const channelTarget = entryPx - (entryDch.high - entryDch.low);

      if (mode === 'M0') {
        if (cur.close >= trailingStop) { exitNow = true; }
      } else if (mode === 'M1') {
        if (cur.high >= midTarget) { exitNow = true; exitPx = midTarget; }
      } else if (mode === 'M2') {
        if (cur.low <= channelTarget) { exitNow = true; exitPx = channelTarget; }
      } else if (mode === 'M3') {
        if (cur.high >= midTarget) { exitNow = true; exitPx = midTarget; }
        else if (cur.close >= trailingStop) { exitNow = true; }
      }

      if (exitNow) {
        const ret = (entryPx - exitPx) / entryPx - 2 * COST;
        const pnl = equity * ret;
        equity += pnl;
        if (pnl > 0) { wins++; grossProfit += pnl; } else { grossLoss += -pnl; }
        trades++;
        state = 'flat'; entryPx = 0; entryDch = null; trailingAnchor = 0;
      } else {
        if (cur.close < trailingAnchor || trailingAnchor === 0) trailingAnchor = cur.close;
      }
    }

    // Entry logic — only when flat (same Donchian breakout as runtime)
    if (state === 'flat') {
      const longBreakout = source === 'close' ? cur.close >= dch.high : cur.high >= dch.high;
      const shortBreakout = source === 'close' ? cur.close <= dch.low : cur.low <= dch.low;
      if (longBreakout) {
        state = 'long'; entryPx = cur.close; entryDch = dch; trailingAnchor = cur.close;
      } else if (shortBreakout) {
        state = 'short'; entryPx = cur.close; entryDch = dch; trailingAnchor = cur.close;
      }
    }

    // Drawdown tracking
    if (equity > peakEquity) peakEquity = equity;
    const dd = (peakEquity - equity) / peakEquity * 100;
    if (dd > maxDD) maxDD = dd;
  }

  const totalReturnPct = (equity - INITIAL_BALANCE) / INITIAL_BALANCE * 100;
  const winRate = trades > 0 ? (wins / trades * 100) : 0;
  const pf = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? Infinity : 0);
  return { trades, wins, winRatePct: winRate, totalReturnPct, maxDDPct: maxDD, profitFactor: pf, finalEquity: equity };
};

// ── Main ──
(async () => {
  console.log(`[research] apikey=${APIKEY} interval=${INTERVAL} bars=${BARS}`);
  console.log(`[research] symbols=${SYMBOLS.join(',')} lengths=${LENGTHS.join(',')} tps=${TPS.join(',')} sources=${SOURCES.join(',')}`);

  await initDB();
  await ensureExchangeClientInitialized(APIKEY);

  const rows = [];
  rows.push(['symbol', 'interval', 'length', 'tp_pct', 'source', 'mode',
             'trades', 'win_rate_pct', 'total_return_pct', 'max_dd_pct', 'profit_factor', 'final_equity'].join(','));

  for (const sym of SYMBOLS) {
    let bars;
    try {
      const raw = await getMarketData(APIKEY, sym, INTERVAL, BARS);
      bars = (raw || []).map((b) => ({
        time: b.time || b.openTime || b.timestamp,
        open: parseFloat(b.open), high: parseFloat(b.high),
        low: parseFloat(b.low), close: parseFloat(b.close),
      })).filter((b) => Number.isFinite(b.close)).sort((a, b) => a.time - b.time);
      console.log(`[${sym}] loaded ${bars.length} bars (${new Date(bars[0]?.time || 0).toISOString().slice(0,10)} → ${new Date(bars[bars.length-1]?.time || 0).toISOString().slice(0,10)})`);
    } catch (e) {
      console.error(`[${sym}] fetch failed: ${e.message}`);
      continue;
    }

    for (const length of LENGTHS) {
      for (const tp of TPS) {
        for (const src of SOURCES) {
          for (const mode of ['M0', 'M1', 'M2', 'M3']) {
            const r = runOne(bars, length, tp, src, mode);
            rows.push([
              sym, INTERVAL, length, tp, src, mode,
              r.trades, fmt(r.winRatePct, 2), fmt(r.totalReturnPct, 2), fmt(r.maxDDPct, 2),
              fmt(r.profitFactor, 3), fmt(r.finalEquity, 2),
            ].join(','));
          }
        }
      }
    }
  }

  fs.writeFileSync(OUT, rows.join('\n') + '\n');
  console.log(`[research] wrote ${rows.length - 1} rows → ${OUT}`);

  // Summary table to stdout: best mode per (symbol, length, tp, source) by total_return
  console.log('\n=== Top result per (symbol, length, tp, source) ===');
  const byKey = new Map();
  for (const line of rows.slice(1)) {
    const c = line.split(',');
    const k = `${c[0]}|${c[2]}|${c[3]}|${c[4]}`;
    const ret = parseFloat(c[8]);
    const cur = byKey.get(k);
    if (!cur || ret > cur.ret) byKey.set(k, { line, ret });
  }
  for (const v of byKey.values()) console.log(`  ${v.line}`);

  // Mode aggregates
  console.log('\n=== Mode aggregates (mean across all configs) ===');
  const agg = { M0: [], M1: [], M2: [], M3: [] };
  for (const line of rows.slice(1)) {
    const c = line.split(',');
    agg[c[5]].push({ ret: parseFloat(c[8]), dd: parseFloat(c[9]), pf: parseFloat(c[10]), trades: parseInt(c[6], 10) });
  }
  console.log('mode | mean_return% | mean_DD% | mean_PF | mean_trades | n_configs');
  for (const m of ['M0', 'M1', 'M2', 'M3']) {
    const xs = agg[m]; if (!xs.length) continue;
    const mean = (k) => xs.reduce((a, x) => a + (Number.isFinite(x[k]) ? x[k] : 0), 0) / xs.length;
    console.log(`  ${m} | ${fmt(mean('ret'),2)} | ${fmt(mean('dd'),2)} | ${fmt(mean('pf'),3)} | ${fmt(mean('trades'),1)} | ${xs.length}`);
  }
})().catch((e) => { console.error(e); process.exit(1); });

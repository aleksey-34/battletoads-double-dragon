/**
 * Z-Score Mean Reversion Sweep — Micro Timeframes (1m / 5m)
 * 
 * Стратегия: Stat_Arb_ZScore — mean reversion по z-score.
 * Режимы: MONO (один символ) и SYNTHETIC (пара символов, спред-арбитраж).
 * 
 * Свип параметров:
 *   - window:      [20, 40, 60, 90, 120]
 *   - zEntry:      [1.5, 2.0, 2.5]
 *   - zExit:       [0.3, 0.5, 0.75]
 *   - zStop:       [3.0, 3.5, 4.0]
 * 
 * Символы (MEXC futures): PEPE, WIF, SUI, DOGE, SOL, ARB, ORDI
 * Синтетические пары: все комбинации C(7,2) = 21 пара
 * Таймфреймы: 1m (1 мес), 5m (3 мес)
 */

'use strict';

const ccxt = require('ccxt');

// ════════════════════════════════════════════════════════════════
// CONFIG
// ════════════════════════════════════════════════════════════════

const SYMBOLS = ['PEPE/USDT:USDT', 'WIF/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT', 'SOL/USDT:USDT', 'ARB/USDT:USDT', 'ORDI/USDT:USDT'];
const SHORT_NAMES = ['PEPE', 'WIF', 'SUI', 'DOGE', 'SOL', 'ARB', 'ORDI'];

const TIMEFRAMES = [
  { tf: '1m', days: 30, intervalMs: 60000 },
  { tf: '5m', days: 90, intervalMs: 300000 },
];

const FEE_RATE = 0.0008; // MEXC taker 0.08% per side

// Sweep grid
const WINDOWS   = [20, 40, 60, 90, 120];
const Z_ENTRIES  = [1.5, 2.0, 2.5];
const Z_EXITS    = [0.3, 0.5, 0.75];
const Z_STOPS    = [3.0, 3.5, 4.0];

// Risk / position sizing
const INITIAL_BALANCE = 1000;
const LEVERAGE = 10;
const POSITION_SIZE_PCT = 0.1; // 10% of equity per trade
const MAX_DAILY_LOSS = 0.15;   // 15% daily loss → stop trading

// Minimum trades for result to be valid
const MIN_TRADES = 15;

// ════════════════════════════════════════════════════════════════
// HELPERS
// ════════════════════════════════════════════════════════════════

function mean(arr) {
  if (!arr.length) return 0;
  let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

function stddev(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  let s = 0; for (let i = 0; i < arr.length; i++) { const d = arr[i] - m; s += d * d; }
  return Math.sqrt(s / arr.length);
}

function sharpeRatio(returns) {
  if (returns.length < 2) return 0;
  const m = mean(returns);
  const s = stddev(returns);
  return s > 1e-12 ? (m / s) * Math.sqrt(returns.length) : 0;
}

// ════════════════════════════════════════════════════════════════
// FETCH CANDLES (MEXC via ccxt, with pagination)
// ════════════════════════════════════════════════════════════════

async function fetchCandles(exchange, symbol, tf, days) {
  const intervalMs = tf === '5m' ? 300000 : 60000;
  const untilMs = Date.now();
  const sinceMs = untilMs - days * 86400000;
  const all = [];
  let since = sinceMs;

  while (since < untilMs) {
    const raw = await exchange.fetchOHLCV(symbol, tf, since, 1000);
    if (!raw || !raw.length) break;
    for (const c of raw) {
      if (c[0] >= untilMs) break;
      all.push({ t: c[0], o: c[1], h: c[2], l: c[3], c: c[4], v: c[5] });
    }
    const last = raw[raw.length - 1][0];
    if (last <= since) break;
    since = last + intervalMs;
    await new Promise(r => setTimeout(r, 200));
  }

  // dedup by timestamp
  const seen = new Set();
  return all.filter(x => { if (seen.has(x.t)) return false; seen.add(x.t); return true; })
    .sort((a, b) => a.t - b.t);
}

// ════════════════════════════════════════════════════════════════
// BUILD SYNTHETIC CANDLES (pair ratio)
// ════════════════════════════════════════════════════════════════

function buildSyntheticCandles(baseCandles, quoteCandles) {
  const quoteMap = new Map();
  for (const c of quoteCandles) quoteMap.set(c.t, c);

  const result = [];
  for (const bc of baseCandles) {
    const qc = quoteMap.get(bc.t);
    if (!qc || qc.o <= 0 || qc.c <= 0 || qc.h <= 0 || qc.l <= 0) continue;

    const open = bc.o / qc.o;
    const close = bc.c / qc.c;
    const rHL = bc.h / qc.l;
    const rLH = bc.l / qc.h;
    const high = Math.max(open, close, rHL, rLH);
    const low = Math.min(open, close, rHL, rLH);

    result.push({ t: bc.t, o: open, h: high, l: low, c: close, v: bc.v + qc.v });
  }
  return result;
}

// ════════════════════════════════════════════════════════════════
// Z-SCORE BACKTEST ENGINE
// ════════════════════════════════════════════════════════════════

function backtestZScore(candles, params) {
  const { window, zEntry, zExit, zStop } = params;
  if (candles.length < window + 2) return null;

  let equity = INITIAL_BALANCE;
  let peakEquity = equity;
  let maxDD = 0;
  let position = null; // { side: 'long'|'short', entryPrice, size, entryIdx }
  const trades = [];
  const equityCurve = [];
  let dailyPnl = 0;
  let currentDay = null;
  let stopped = false;

  for (let i = window; i < candles.length; i++) {
    const cur = candles[i];
    const day = Math.floor(cur.t / 86400000);

    // Daily loss reset
    if (day !== currentDay) {
      currentDay = day;
      dailyPnl = 0;
      stopped = false;
    }

    // Z-score calculation
    const closeSeries = [];
    for (let j = i - window; j < i; j++) closeSeries.push(candles[j].c);
    const m = mean(closeSeries);
    const s = stddev(closeSeries);
    if (s < 1e-12) continue;
    const z = (cur.c - m) / s;

    // Check open position exits
    if (position) {
      let exitReason = null;
      const entryP = position.entryPrice;
      const curP = cur.c;

      if (position.side === 'long') {
        // Mean reversion exit: z came back up
        if (z >= -zExit) exitReason = 'mean_revert';
        // Stop: z dropped even further
        else if (z <= -zStop) exitReason = 'zscore_stop';
      } else {
        // Mean reversion exit: z came back down
        if (z <= zExit) exitReason = 'mean_revert';
        // Stop: z spiked even higher
        else if (z >= zStop) exitReason = 'zscore_stop';
      }

      if (exitReason) {
        const pnlPct = position.side === 'long'
          ? (curP - entryP) / entryP
          : (entryP - curP) / entryP;
        const grossPnl = pnlPct * position.size * LEVERAGE;
        const fee = position.size * LEVERAGE * FEE_RATE * 2; // roundtrip
        const netPnl = grossPnl - fee;

        equity += netPnl;
        dailyPnl += netPnl / INITIAL_BALANCE;

        trades.push({
          side: position.side,
          entryIdx: position.entryIdx,
          exitIdx: i,
          entryPrice: entryP,
          exitPrice: curP,
          pnlPct: (netPnl / position.size) * 100,
          netPnl,
          reason: exitReason,
          zEntry: position.zAtEntry,
          zExit: z,
          holdBars: i - position.entryIdx,
        });

        position = null;

        if (equity <= 0) { equity = 0; break; }
        if (dailyPnl <= -MAX_DAILY_LOSS) stopped = true;
      }
    }

    // Try entry (no position, not stopped)
    if (!position && !stopped && equity > 0) {
      const posSize = equity * POSITION_SIZE_PCT;

      if (z <= -zEntry) {
        // Price below mean by zEntry sigma → LONG (expect revert up)
        position = { side: 'long', entryPrice: cur.c, size: posSize, entryIdx: i, zAtEntry: z };
      } else if (z >= zEntry) {
        // Price above mean by zEntry sigma → SHORT (expect revert down)
        position = { side: 'short', entryPrice: cur.c, size: posSize, entryIdx: i, zAtEntry: z };
      }
    }

    // Track equity
    equityCurve.push(equity);
    if (equity > peakEquity) peakEquity = equity;
    const dd = peakEquity > 0 ? (peakEquity - equity) / peakEquity : 0;
    if (dd > maxDD) maxDD = dd;
  }

  // Force close open position at end
  if (position && candles.length > 0) {
    const curP = candles[candles.length - 1].c;
    const pnlPct = position.side === 'long'
      ? (curP - position.entryPrice) / position.entryPrice
      : (position.entryPrice - curP) / position.entryPrice;
    const grossPnl = pnlPct * position.size * LEVERAGE;
    const fee = position.size * LEVERAGE * FEE_RATE * 2;
    equity += grossPnl - fee;
    trades.push({
      side: position.side, entryIdx: position.entryIdx, exitIdx: candles.length - 1,
      entryPrice: position.entryPrice, exitPrice: curP,
      pnlPct: ((grossPnl - fee) / position.size) * 100, netPnl: grossPnl - fee,
      reason: 'end_of_data', zEntry: position.zAtEntry, zExit: 0, holdBars: candles.length - 1 - position.entryIdx,
    });
  }

  if (trades.length < MIN_TRADES) return null;

  // Stats
  const wins = trades.filter(t => t.netPnl > 0);
  const losses = trades.filter(t => t.netPnl <= 0);
  const grossProfit = wins.reduce((s, t) => s + t.netPnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? 99 : 0;
  const wr = (wins.length / trades.length) * 100;
  const ret = ((equity - INITIAL_BALANCE) / INITIAL_BALANCE) * 100;
  const avgTrade = mean(trades.map(t => t.pnlPct));
  const avgHold = mean(trades.map(t => t.holdBars));
  const tradeReturns = trades.map(t => t.netPnl / INITIAL_BALANCE);
  const sh = sharpeRatio(tradeReturns);

  const meanRevExits = trades.filter(t => t.reason === 'mean_revert').length;
  const stopExits = trades.filter(t => t.reason === 'zscore_stop').length;
  const endExits = trades.filter(t => t.reason === 'end_of_data').length;

  // Sweep score: ret + 10*pf + 0.12*wr - 1.2*dd(%) + tradeBonus
  const tradeBonus = trades.length >= 40 ? 5 : trades.length >= 25 ? 2 : 0;
  const score = ret + 10 * pf + 0.12 * wr - 1.2 * (maxDD * 100) + tradeBonus;

  return {
    trades: trades.length,
    wins: wins.length,
    wr: +wr.toFixed(1),
    ret: +ret.toFixed(2),
    maxDD: +(maxDD * 100).toFixed(1),
    pf: +pf.toFixed(2),
    sharpe: +sh.toFixed(2),
    avgTrade: +avgTrade.toFixed(3),
    avgHold: +avgHold.toFixed(1),
    exits: { meanRev: meanRevExits, stop: stopExits, end: endExits },
    score: +score.toFixed(2),
    equity: +equity.toFixed(2),
  };
}

// ════════════════════════════════════════════════════════════════
// GENERATE PARAMETER COMBOS
// ════════════════════════════════════════════════════════════════

function generateParamGrid() {
  const combos = [];
  for (const window of WINDOWS) {
    for (const zEntry of Z_ENTRIES) {
      for (const zExit of Z_EXITS) {
        for (const zStop of Z_STOPS) {
          if (zStop <= zEntry) continue; // stop must be beyond entry
          if (zExit >= zEntry) continue; // exit must be before entry
          combos.push({ window, zEntry, zExit, zStop });
        }
      }
    }
  }
  return combos;
}

// ════════════════════════════════════════════════════════════════
// GENERATE SYNTHETIC PAIRS
// ════════════════════════════════════════════════════════════════

function generatePairs() {
  const pairs = [];
  for (let i = 0; i < SHORT_NAMES.length; i++) {
    for (let j = i + 1; j < SHORT_NAMES.length; j++) {
      pairs.push({ base: i, quote: j, name: `${SHORT_NAMES[i]}/${SHORT_NAMES[j]}` });
    }
  }
  return pairs;
}

// ════════════════════════════════════════════════════════════════
// MAIN
// ════════════════════════════════════════════════════════════════

async function main() {
  console.log('╔══════════════════════════════════════════════════════════════════╗');
  console.log('║  Z-Score Mean Reversion Sweep — Mono + Synthetic Pairs         ║');
  console.log('╚══════════════════════════════════════════════════════════════════╝');
  console.log(`Time: ${new Date().toISOString()}`);

  const exchange = new ccxt.mexc({ enableRateLimit: true });
  const paramGrid = generateParamGrid();
  const synthPairs = generatePairs();

  console.log(`\nParam combos: ${paramGrid.length}`);
  console.log(`Mono symbols: ${SYMBOLS.length}`);
  console.log(`Synthetic pairs: ${synthPairs.length}`);
  console.log(`Timeframes: ${TIMEFRAMES.map(t => t.tf).join(', ')}`);
  console.log(`Total runs: ${paramGrid.length} × (${SYMBOLS.length} mono + ${synthPairs.length} synth) × ${TIMEFRAMES.length} TFs`);
  console.log(`           = ${paramGrid.length * (SYMBOLS.length + synthPairs.length) * TIMEFRAMES.length} backtests\n`);

  // Collect ALL results
  const allResults = [];

  for (const tfCfg of TIMEFRAMES) {
    console.log(`\n${'═'.repeat(70)}`);
    console.log(`>>> Timeframe: ${tfCfg.tf} (${tfCfg.days} days)`);
    console.log(`${'═'.repeat(70)}`);

    // Fetch candles for all symbols at this TF
    const candleCache = {};
    for (let si = 0; si < SYMBOLS.length; si++) {
      const sym = SYMBOLS[si];
      const name = SHORT_NAMES[si];
      process.stdout.write(`  Fetching ${name} ${tfCfg.tf}...`);
      candleCache[si] = await fetchCandles(exchange, sym, tfCfg.tf, tfCfg.days);
      console.log(` → ${candleCache[si].length} candles`);
    }

    // ─── MONO sweep ───
    console.log(`\n  --- MONO symbols (${SYMBOLS.length}) × ${paramGrid.length} params ---`);
    let monoCount = 0;
    for (let si = 0; si < SYMBOLS.length; si++) {
      const candles = candleCache[si];
      const name = SHORT_NAMES[si];
      for (const params of paramGrid) {
        const res = backtestZScore(candles, params);
        if (res) {
          allResults.push({
            mode: 'mono',
            asset: name,
            tf: tfCfg.tf,
            ...params,
            ...res,
          });
          monoCount++;
        }
      }
    }
    console.log(`  Mono valid results: ${monoCount}`);

    // ─── SYNTHETIC sweep ───
    console.log(`\n  --- SYNTHETIC pairs (${synthPairs.length}) × ${paramGrid.length} params ---`);
    let synthCount = 0;
    for (const pair of synthPairs) {
      const baseCandles = candleCache[pair.base];
      const quoteCandles = candleCache[pair.quote];
      const synthCandles = buildSyntheticCandles(baseCandles, quoteCandles);

      if (synthCandles.length < 60) {
        continue; // not enough data
      }

      for (const params of paramGrid) {
        const res = backtestZScore(synthCandles, params);
        if (res) {
          allResults.push({
            mode: 'synth',
            asset: pair.name,
            tf: tfCfg.tf,
            ...params,
            ...res,
          });
          synthCount++;
        }
      }
    }
    console.log(`  Synth valid results: ${synthCount}`);
  }

  // ════════════════════════════════════════════════════════════════
  // RESULTS
  // ════════════════════════════════════════════════════════════════

  console.log(`\n\n${'═'.repeat(80)}`);
  console.log('RESULTS SUMMARY');
  console.log(`${'═'.repeat(80)}`);
  console.log(`Total valid backtests: ${allResults.length}`);

  // Filter profitable (PF >= 1.0)
  const profitable = allResults.filter(r => r.pf >= 1.0);
  console.log(`Profitable (PF ≥ 1.0): ${profitable.length}`);

  // Robust filter: PF ≥ 1.15, DD ≤ 30%, trades ≥ 25
  const robust = allResults.filter(r => r.pf >= 1.15 && r.maxDD <= 30 && r.trades >= 25);
  console.log(`Robust (PF≥1.15, DD≤30%, trades≥25): ${robust.length}`);

  // Sort by score descending
  allResults.sort((a, b) => b.score - a.score);
  profitable.sort((a, b) => b.score - a.score);
  robust.sort((a, b) => b.score - a.score);

  // ─── TOP 30 overall ───
  console.log(`\n\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
  console.log(`║  TOP 30 BY SCORE (all)                                                                                    ║`);
  console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝`);
  printTable(allResults.slice(0, 30));

  // ─── TOP 20 profitable ───
  if (profitable.length > 0) {
    console.log(`\n\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  TOP 20 PROFITABLE (PF ≥ 1.0)                                                                            ║`);
    console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝`);
    printTable(profitable.slice(0, 20));
  }

  // ─── TOP 20 robust ───
  if (robust.length > 0) {
    console.log(`\n\n╔════════════════════════════════════════════════════════════════════════════════════════════════════════════╗`);
    console.log(`║  TOP 20 ROBUST (PF≥1.15, DD≤30%, trades≥25)                                                              ║`);
    console.log(`╚════════════════════════════════════════════════════════════════════════════════════════════════════════════════╝`);
    printTable(robust.slice(0, 20));
  }

  // ─── Summary by mode ───
  console.log('\n\n── Summary by Mode ──');
  for (const mode of ['mono', 'synth']) {
    const sub = profitable.filter(r => r.mode === mode);
    console.log(`  ${mode.toUpperCase()}: ${sub.length} profitable configs`);
    if (sub.length > 0) {
      const best = sub[0];
      console.log(`    Best: ${best.asset} ${best.tf} w=${best.window} zE=${best.zEntry} zX=${best.zExit} zS=${best.zStop} → PF=${best.pf} WR=${best.wr}% Ret=${best.ret}% DD=${best.maxDD}%`);
    }
  }

  // ─── Summary by TF ───
  console.log('\n── Summary by Timeframe ──');
  for (const tfCfg of TIMEFRAMES) {
    const sub = profitable.filter(r => r.tf === tfCfg.tf);
    console.log(`  ${tfCfg.tf}: ${sub.length} profitable configs`);
    if (sub.length > 0) {
      const avgPF = mean(sub.map(r => r.pf));
      const avgWR = mean(sub.map(r => r.wr));
      console.log(`    Avg PF=${avgPF.toFixed(2)}, Avg WR=${avgWR.toFixed(1)}%`);
    }
  }

  // ─── Summary by asset (top 5 most appearing in profitable) ───
  console.log('\n── Top Assets in Profitable Configs ──');
  const assetCount = {};
  for (const r of profitable) {
    assetCount[r.asset] = (assetCount[r.asset] || 0) + 1;
  }
  const sortedAssets = Object.entries(assetCount).sort((a, b) => b[1] - a[1]).slice(0, 10);
  for (const [asset, count] of sortedAssets) {
    const sub = profitable.filter(r => r.asset === asset);
    const bestPF = Math.max(...sub.map(r => r.pf));
    console.log(`  ${asset}: ${count} configs (best PF=${bestPF.toFixed(2)})`);
  }

  // Save JSON
  const fs = require('fs');
  const outPath = __dirname + '/zscore_sweep_results.json';
  fs.writeFileSync(outPath, JSON.stringify({
    timestamp: new Date().toISOString(),
    totalResults: allResults.length,
    profitable: profitable.length,
    robust: robust.length,
    top50: allResults.slice(0, 50),
    topProfitable: profitable.slice(0, 30),
    topRobust: robust.slice(0, 30),
  }, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

function printTable(rows) {
  if (!rows.length) { console.log('  (no results)'); return; }

  const header = `${'#'.padStart(3)} | ${'Mode'.padEnd(5)} | ${'Asset'.padEnd(10)} | ${'TF'.padEnd(3)} | ${'W'.padStart(3)} | ${'zE'.padStart(4)} | ${'zX'.padStart(4)} | ${'zS'.padStart(4)} | ${'Trades'.padStart(6)} | ${'WR%'.padStart(5)} | ${'Return%'.padStart(8)} | ${'DD%'.padStart(5)} | ${'PF'.padStart(5)} | ${'Shrp'.padStart(5)} | ${'AvgT%'.padStart(6)} | ${'Hold'.padStart(5)} | ${'MR/ST/E'.padEnd(9)} | ${'Score'.padStart(7)}`;
  console.log(header);
  console.log('─'.repeat(header.length));

  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    console.log(
      `${(i + 1 + '').padStart(3)} | ${r.mode.padEnd(5)} | ${r.asset.padEnd(10)} | ${r.tf.padEnd(3)} | ${('' + r.window).padStart(3)} | ${r.zEntry.toFixed(1).padStart(4)} | ${r.zExit.toFixed(1).padStart(4)} | ${r.zStop.toFixed(1).padStart(4)} | ${('' + r.trades).padStart(6)} | ${r.wr.toFixed(1).padStart(5)} | ${r.ret.toFixed(1).padStart(8)} | ${r.maxDD.toFixed(1).padStart(5)} | ${r.pf.toFixed(2).padStart(5)} | ${r.sharpe.toFixed(2).padStart(5)} | ${r.avgTrade.toFixed(2).padStart(6)} | ${r.avgHold.toFixed(0).padStart(5)} | ${(r.exits.meanRev + '/' + r.exits.stop + '/' + r.exits.end).padEnd(9)} | ${r.score.toFixed(1).padStart(7)}`
    );
  }
}

main().catch(err => {
  console.error('FATAL:', err);
  process.exit(1);
});

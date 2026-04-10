// ─── Razgon Backtest Engine — Low / Mid / High Presets ───────────────────────
//
// Runs 1m-candle backtest of the MicroDonchian Momentum Scalping strategy
// over 1-3 months of historical data (fetched from MEXC via ccxt).
// Produces per-preset metrics: return %, maxDD %, profit factor, total trades.
//
// Usage:  npx ts-node backend/src/razgon/razgonBacktest.ts
// ──────────────────────────────────────────────────────────────────────────────

import { computeMomentumSignal, MomentumSignalResult } from './razgonStrategy';
import { RAZGON_PRESETS, RazgonPresetMode, Candle1m } from './razgonTypes';

// ── CCXT candle fetcher ──────────────────────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-var-requires
const ccxt = require('ccxt');

const EXCHANGE_ID = 'mexc';
const SYMBOLS = ['PEPE/USDT:USDT', 'WIF/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT', 'SOL/USDT:USDT', 'ARB/USDT:USDT', 'ORDI/USDT:USDT'];
const TIMEFRAME = '1m';
const MONTHS_BACK = 1; // MEXC keeps ~1 month of 1m candles

async function fetchCandles(exchange: any, symbol: string, sinceMs: number, untilMs: number): Promise<Candle1m[]> {
  const allCandles: Candle1m[] = [];
  let since = sinceMs;
  const limit = 1000;

  while (since < untilMs) {
    const raw = await exchange.fetchOHLCV(symbol, TIMEFRAME, since, limit);
    if (!raw || raw.length === 0) break;

    for (const c of raw) {
      if (c[0]! >= untilMs) break;
      allCandles.push({
        timeMs: c[0]! as number,
        open: c[1]! as number,
        high: c[2]! as number,
        low: c[3]! as number,
        close: c[4]! as number,
        volume: c[5]! as number,
      });
    }

    const lastTs = raw[raw.length - 1]![0]!;
    if (lastTs <= since) break; // no progress
    since = lastTs + 60_000;

    // Rate limit
    await new Promise(r => setTimeout(r, 200));
  }

  return allCandles;
}

// ── Backtest simulator ───────────────────────────────────────────────────────

interface BacktestTrade {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  exitPrice: number;
  entryTime: number;
  exitTime: number;
  pnlPct: number;        // net of fees (leverage-adjusted)
  exitReason: 'tp' | 'sl' | 'timeout';
}

interface BacktestResult {
  preset: RazgonPresetMode;
  totalTrades: number;
  wins: number;
  losses: number;
  winRate: number;
  totalReturnPct: number;
  maxDrawdownPct: number;
  profitFactor: number;
  avgTradePnlPct: number;
  sharpe: number;
  trades: BacktestTrade[];
}

interface OpenPosition {
  symbol: string;
  side: 'long' | 'short';
  entryPrice: number;
  entryTime: number;
  tpAnchor: number;      // trailing TP anchor
  slPrice: number;
}

function runBacktest(
  candlesBySymbol: Map<string, Candle1m[]>,
  preset: RazgonPresetMode,
): BacktestResult {
  const cfg = RAZGON_PRESETS[preset];
  const lev = cfg.momentum.leverage;
  const slPct = cfg.momentum.stopLossPercent / 100;
  const tpPct = cfg.momentum.trailingTpPercent / 100;
  const volMul = cfg.momentum.volumeMultiplier;
  const atrMin = cfg.momentum.atrFilterMin;
  const maxPos = cfg.momentum.maxConcurrentPositions;
  const maxTimeSec = 900; // 15min timeout
  const feeRate = 0.0008; // 0.08% taker fee per side

  const allTrades: BacktestTrade[] = [];
  const openPositions: OpenPosition[] = [];

  // Build a unified timeline sorted by timestamp
  const allTimestamps = new Set<number>();
  for (const [, candles] of candlesBySymbol) {
    for (const c of candles) allTimestamps.add(c.timeMs);
  }
  const sortedTimes = Array.from(allTimestamps).sort((a, b) => a - b);

  // Index candles by symbol and time
  const candleIndex = new Map<string, Map<number, number>>(); // symbol → (timeMs → index)
  for (const [sym, candles] of candlesBySymbol) {
    const idx = new Map<number, number>();
    for (let i = 0; i < candles.length; i++) {
      idx.set(candles[i].timeMs, i);
    }
    candleIndex.set(sym, idx);
  }

  // Daily loss tracking
  let dayStart = 0;
  let dayPnl = 0;
  let dayLocked = false;

  for (const ts of sortedTimes) {
    // Reset daily loss at midnight UTC
    const dayMs = ts - (ts % 86400000);
    if (dayMs !== dayStart) {
      dayStart = dayMs;
      dayPnl = 0;
      dayLocked = false;
    }

    if (dayLocked) continue;

    // Check exits for all open positions
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const symCandles = candlesBySymbol.get(pos.symbol);
      const symIdx = candleIndex.get(pos.symbol);
      if (!symCandles || !symIdx) continue;

      const ci = symIdx.get(ts);
      if (ci === undefined) continue;
      const candle = symCandles[ci];

      const currentPrice = candle.close;
      const elapsed = (ts - pos.entryTime) / 1000;

      let exitPrice = 0;
      let exitReason: 'tp' | 'sl' | 'timeout' | null = null;

      // Check SL
      if (pos.side === 'long' && candle.low <= pos.slPrice) {
        exitPrice = pos.slPrice;
        exitReason = 'sl';
      } else if (pos.side === 'short' && candle.high >= pos.slPrice) {
        exitPrice = pos.slPrice;
        exitReason = 'sl';
      }
      // Check timeout
      else if (elapsed >= maxTimeSec) {
        exitPrice = currentPrice;
        exitReason = 'timeout';
      }
      // Update trailing TP
      else {
        if (pos.side === 'long') {
          if (currentPrice > pos.tpAnchor) pos.tpAnchor = currentPrice;
          // Trail: if price pulled back tpPct from peak AND we're in profit
          const trailStop = pos.tpAnchor * (1 - tpPct);
          if (currentPrice <= trailStop && pos.tpAnchor > pos.entryPrice * (1 + tpPct * 0.5)) {
            exitPrice = currentPrice;
            exitReason = 'tp';
          }
        } else {
          if (currentPrice < pos.tpAnchor) pos.tpAnchor = currentPrice;
          const trailStop = pos.tpAnchor * (1 + tpPct);
          if (currentPrice >= trailStop && pos.tpAnchor < pos.entryPrice * (1 - tpPct * 0.5)) {
            exitPrice = currentPrice;
            exitReason = 'tp';
          }
        }
      }

      if (exitReason && exitPrice > 0) {
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;
        // Fee is on notional (entry + exit), not multiplied by leverage again
        const netPnl = (rawPnl * lev) - (feeRate * 2);

        allTrades.push({
          symbol: pos.symbol,
          side: pos.side,
          entryPrice: pos.entryPrice,
          exitPrice,
          entryTime: pos.entryTime,
          exitTime: ts,
          pnlPct: netPnl * 100,
          exitReason,
        });

        dayPnl += netPnl;
        if (dayPnl <= -cfg.risk.maxDailyLoss) dayLocked = true;

        openPositions.splice(i, 1);
      }
    }

    if (dayLocked) continue;

    // Check entries per symbol
    if (openPositions.length >= maxPos) continue;

    for (const [sym, candles] of candlesBySymbol) {
      if (openPositions.length >= maxPos) break;
      if (openPositions.some(p => p.symbol === sym)) continue;

      const symIdx = candleIndex.get(sym);
      if (!symIdx) continue;
      const ci = symIdx.get(ts);
      if (ci === undefined || ci < 25) continue; // need lookback

      const lookback = candles.slice(0, ci); // closed candles before this one
      if (lookback.length < 25) continue;

      const current = candles[ci];
      const sig = computeMomentumSignal(lookback, current.close, current.volume, 5, volMul, atrMin);

      if (sig.signal === 'none') continue;

      const entry = current.close;
      const side = sig.signal;
      const slPrice = side === 'long' ? entry * (1 - slPct) : entry * (1 + slPct);

      openPositions.push({
        symbol: sym,
        side,
        entryPrice: entry,
        entryTime: ts,
        tpAnchor: entry,
        slPrice,
      });
    }
  }

  // Force close remaining
  for (const pos of openPositions) {
    const symCandles = candlesBySymbol.get(pos.symbol);
    if (!symCandles || symCandles.length === 0) continue;
    const last = symCandles[symCandles.length - 1];
    const rawPnl = pos.side === 'long'
      ? (last.close - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - last.close) / pos.entryPrice;
    const netPnl = (rawPnl * lev) - (feeRate * 2);
    allTrades.push({
      symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice,
      exitPrice: last.close, entryTime: pos.entryTime, exitTime: last.timeMs,
      pnlPct: netPnl * 100, exitReason: 'timeout',
    });
  }

  // Compute metrics
  const wins = allTrades.filter(t => t.pnlPct > 0).length;
  const losses = allTrades.length - wins;
  const grossProfit = allTrades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  // Cumulative equity curve for drawdown
  let equity = 100;
  let peak = 100;
  let maxDD = 0;
  const returns: number[] = [];

  for (const t of allTrades.sort((a, b) => a.exitTime - b.exitTime)) {
    const retPct = t.pnlPct / 100;
    equity *= (1 + retPct);
    if (equity > peak) peak = equity;
    const dd = (peak - equity) / peak;
    if (dd > maxDD) maxDD = dd;
    returns.push(retPct);
  }

  const totalReturn = equity - 100;
  const avgReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const stdReturn = returns.length > 1
    ? Math.sqrt(returns.reduce((s, r) => s + (r - avgReturn) ** 2, 0) / (returns.length - 1))
    : 0;
  const sharpe = stdReturn > 0 ? (avgReturn / stdReturn) * Math.sqrt(returns.length) : 0;

  return {
    preset,
    totalTrades: allTrades.length,
    wins,
    losses,
    winRate: allTrades.length > 0 ? wins / allTrades.length : 0,
    totalReturnPct: totalReturn,
    maxDrawdownPct: maxDD * 100,
    profitFactor,
    avgTradePnlPct: allTrades.length > 0 ? allTrades.reduce((s, t) => s + t.pnlPct, 0) / allTrades.length : 0,
    sharpe,
    trades: allTrades,
  };
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log('=== Razgon Backtest Engine ===');
  console.log(`Symbols: ${SYMBOLS.join(', ')}`);
  console.log(`Period: ${MONTHS_BACK} months of 1m candles`);
  console.log('');

  const exchange = new ccxt[EXCHANGE_ID]({ enableRateLimit: true });

  const now = Date.now();
  const sinceMs = now - MONTHS_BACK * 30 * 24 * 60 * 60 * 1000;

  // Fetch candles for all symbols
  const candlesBySymbol = new Map<string, Candle1m[]>();

  for (const sym of SYMBOLS) {
    console.log(`Fetching ${sym}...`);
    const candles = await fetchCandles(exchange, sym, sinceMs, now);
    console.log(`  → ${candles.length} candles (${(candles.length / 1440).toFixed(0)} days)`);
    if (candles.length > 0) {
      candlesBySymbol.set(sym, candles);
    }
  }

  console.log('');

  // Run backtest for each preset
  const presets: RazgonPresetMode[] = ['low', 'mid', 'high'];
  const results: BacktestResult[] = [];

  for (const p of presets) {
    console.log(`Running backtest: ${RAZGON_PRESETS[p].label}...`);
    const result = runBacktest(candlesBySymbol, p);
    results.push(result);

    console.log(`  Trades: ${result.totalTrades}`);
    console.log(`  Win Rate: ${(result.winRate * 100).toFixed(1)}%`);
    console.log(`  Return: ${result.totalReturnPct >= 0 ? '+' : ''}${result.totalReturnPct.toFixed(2)}%`);
    console.log(`  Max DD: ${result.maxDrawdownPct.toFixed(2)}%`);
    console.log(`  PF: ${result.profitFactor === Infinity ? '∞' : result.profitFactor.toFixed(2)}`);
    console.log(`  Sharpe: ${result.sharpe.toFixed(2)}`);
    console.log(`  Avg Trade: ${result.avgTradePnlPct >= 0 ? '+' : ''}${result.avgTradePnlPct.toFixed(3)}%`);

    // Exit reason breakdown
    const byReason = { tp: 0, sl: 0, timeout: 0 };
    for (const t of result.trades) byReason[t.exitReason]++;
    console.log(`  Exits: TP=${byReason.tp} SL=${byReason.sl} Timeout=${byReason.timeout}`);
    console.log('');
  }

  // Summary table
  console.log('══════════════════════════════════════════════════════════════');
  console.log('PRESET     | Trades | WinRate | Return    | MaxDD   | PF    ');
  console.log('───────────|────────|─────────|───────────|─────────|───────');
  for (const r of results) {
    const label = RAZGON_PRESETS[r.preset].label.padEnd(10);
    const trades = String(r.totalTrades).padStart(6);
    const wr = `${(r.winRate * 100).toFixed(1)}%`.padStart(7);
    const ret = `${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(1)}%`.padStart(9);
    const dd = `${r.maxDrawdownPct.toFixed(1)}%`.padStart(7);
    const pf = (r.profitFactor === Infinity ? '∞' : r.profitFactor.toFixed(2)).padStart(5);
    console.log(`${label} | ${trades} | ${wr} | ${ret} | ${dd} | ${pf}`);
  }
  console.log('══════════════════════════════════════════════════════════════');

  // Save results to JSON
  const fs = await import('fs');
  const outPath = __dirname + '/../../razgon_backtest_results.json';
  const saveData = results.map(r => ({
    preset: r.preset,
    label: RAZGON_PRESETS[r.preset].label,
    totalTrades: r.totalTrades,
    wins: r.wins,
    losses: r.losses,
    winRate: Math.round(r.winRate * 1000) / 10,
    totalReturnPct: Math.round(r.totalReturnPct * 100) / 100,
    maxDrawdownPct: Math.round(r.maxDrawdownPct * 100) / 100,
    profitFactor: r.profitFactor === Infinity ? 999 : Math.round(r.profitFactor * 100) / 100,
    sharpe: Math.round(r.sharpe * 100) / 100,
    avgTradePnlPct: Math.round(r.avgTradePnlPct * 1000) / 1000,
    monthsBack: MONTHS_BACK,
    symbols: SYMBOLS,
    timestamp: new Date().toISOString(),
  }));
  fs.writeFileSync(outPath, JSON.stringify(saveData, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => {
  console.error('Backtest failed:', err);
  process.exit(1);
});

// ─── Razgon Comprehensive Backtest — Multi-Variant Comparison ────────────────
//
// Variants tested:
//   A) 1m candles / 1 month / MEXC (original strategy)
//   B) 1m candles / 1 month / MEXC (optimized: donchian=15, RSI conf, fixed TP)
//   C) 5m candles / 3 months / MEXC (adapted for swing-scalp)
//   D) 1m candles / 1 month / WEEX (same pairs, compare execution)
//   E) 5m candles / 3 months / WEEX
//
// Each variant runs all 3 presets (low/mid/high).
//
// Usage:  node razgonBacktestV2.js
// ──────────────────────────────────────────────────────────────────────────────

const ccxt = require('ccxt');
const https = require('https');
const fs = require('fs');

// ── Config ──────────────────────────────────────────────────────────────────

const SYMBOLS_CCXT = ['PEPE/USDT:USDT', 'WIF/USDT:USDT', 'SUI/USDT:USDT', 'DOGE/USDT:USDT', 'SOL/USDT:USDT', 'ARB/USDT:USDT', 'ORDI/USDT:USDT'];
const SYMBOLS_WEEX = ['PEPEUSDT', 'WIFUSDT', 'SUIUSDT', 'DOGEUSDT', 'SOLUSDT', 'ARBUSDT', 'ORDIUSDT'];

const PRESETS = {
  low:  { label: 'Low (Safe)',     lev: 10, slPct: 0.50, tpPct: 0.60, volMul: 1.8, atrMin: 0.002,  maxRisk: 0.03, maxDailyLoss: 0.08, maxPos: 2 },
  mid:  { label: 'Mid (Balanced)', lev: 15, slPct: 0.40, tpPct: 0.50, volMul: 1.6, atrMin: 0.0018, maxRisk: 0.04, maxDailyLoss: 0.10, maxPos: 2 },
  high: { label: 'High (Turbo)',   lev: 20, slPct: 0.30, tpPct: 0.45, volMul: 1.5, atrMin: 0.0015, maxRisk: 0.05, maxDailyLoss: 0.10, maxPos: 2 },
};

// ── Candle type ─────────────────────────────────────────────────────────────

// [timeMs, open, high, low, close, volume]

// ── Strategy Indicators ─────────────────────────────────────────────────────

function donchianChannel(candles, period) {
  if (candles.length < period) return { high: NaN, low: NaN };
  const win = candles.slice(-period);
  let h = -Infinity, l = Infinity;
  for (const c of win) { if (c[2] > h) h = c[2]; if (c[3] < l) l = c[3]; }
  return { high: h, low: l };
}

function avgVolume(candles, period = 20) {
  if (candles.length < period) return 0;
  const win = candles.slice(-period);
  return win.reduce((s, c) => s + c[5], 0) / period;
}

function normATR(candles, period = 14) {
  if (candles.length < period + 1) return 0;
  const rel = candles.slice(-(period + 1));
  let sum = 0;
  for (let i = 1; i <= period; i++) {
    const c = rel[i], p = rel[i - 1];
    sum += Math.max(c[2] - c[3], Math.abs(c[2] - p[4]), Math.abs(c[3] - p[4]));
  }
  const atr = sum / period;
  const last = rel[rel.length - 1][4];
  return last > 0 ? atr / last : 0;
}

function computeEMA(candles, period) {
  if (candles.length === 0) return [];
  const k = 2 / (period + 1);
  const ema = [candles[0][4]];
  for (let i = 1; i < candles.length; i++) {
    ema.push(candles[i][4] * k + ema[i - 1] * (1 - k));
  }
  return ema;
}

function emaTrend(candles, period = 20, lookback = 5) {
  const ema = computeEMA(candles, period);
  if (ema.length < lookback + 1) return 'flat';
  const recent = ema[ema.length - 1];
  const past = ema[ema.length - 1 - lookback];
  if (past <= 0) return 'flat';
  const slope = (recent - past) / past;
  if (slope > 0.0002) return 'up';
  if (slope < -0.0002) return 'down';
  return 'flat';
}

function computeRSI(candles, period = 14) {
  if (candles.length < period + 1) return 50;
  const closes = candles.slice(-(period + 1)).map(c => c[4]);
  let gains = 0, losses = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  const avgGain = gains / period;
  const avgLoss = losses / period;
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// ── Signal Generators ───────────────────────────────────────────────────────

// Original strategy: Donchian breakout + volume + EMA trend
function signalOriginal(lookback, price, volume, donchPeriod, volMul, atrMin) {
  if (lookback.length < Math.max(donchPeriod, 21)) return 'none';
  const { high: dH, low: dL } = donchianChannel(lookback, donchPeriod);
  if (!isFinite(dH)) return 'none';
  const avg = avgVolume(lookback, 20);
  const volOk = avg > 0 && volume >= avg * volMul;
  const near = 0.001;

  let signal = 'none';
  if (price >= dH) signal = 'long';
  else if (price <= dL) signal = 'short';
  else if (volOk && price >= dH * (1 - near)) signal = 'long';
  else if (volOk && price <= dL * (1 + near)) signal = 'short';

  if (signal !== 'none') {
    const trend = emaTrend(lookback, 20, 5);
    if (trend === 'flat') signal = 'none';
    else if (signal === 'long' && trend === 'down') signal = 'none';
    else if (signal === 'short' && trend === 'up') signal = 'none';
  }
  return signal;
}

// Optimized: wider Donchian + RSI confirmation + stronger volume filter
function signalOptimized(lookback, price, volume, donchPeriod, volMul, atrMin) {
  if (lookback.length < Math.max(donchPeriod, 25)) return 'none';

  // ATR filter — only trade in volatile conditions
  const atr = normATR(lookback, 14);
  if (atr < atrMin) return 'none';

  const { high: dH, low: dL } = donchianChannel(lookback, donchPeriod);
  if (!isFinite(dH)) return 'none';

  const avg = avgVolume(lookback, 20);
  const volOk = avg > 0 && volume >= avg * volMul;

  // Require volume spike for ALL entries
  if (!volOk) return 'none';

  let signal = 'none';
  if (price >= dH) signal = 'long';
  else if (price <= dL) signal = 'short';

  if (signal === 'none') return 'none';

  // EMA trend confirmation
  const trend = emaTrend(lookback, 20, 5);
  if (trend === 'flat') return 'none';
  if (signal === 'long' && trend === 'down') return 'none';
  if (signal === 'short' && trend === 'up') return 'none';

  // RSI confirmation: long only if RSI > 55 (momentum), short only if RSI < 45
  const rsi = computeRSI(lookback, 14);
  if (signal === 'long' && rsi < 55) return 'none';
  if (signal === 'short' && rsi > 45) return 'none';

  return signal;
}

// 5m adapter: same optimized but tuned for larger candles
function signal5m(lookback, price, volume, donchPeriod, volMul, atrMin) {
  // For 5m, use wider donch (12 bars = 1h), lower vol threshold
  return signalOptimized(lookback, price, volume, donchPeriod, volMul * 0.8, atrMin * 0.7);
}

// ── Backtest Simulator ──────────────────────────────────────────────────────

function runBacktest(candlesBySymbol, presetKey, signalFn, options = {}) {
  const preset = PRESETS[presetKey];
  const lev = preset.lev;
  const slPct = preset.slPct / 100;
  const tpPct = preset.tpPct / 100;
  const volMul = preset.volMul;
  const atrMin = preset.atrMin;
  const maxPos = preset.maxPos;
  const maxTimeSec = options.maxTimeSec || 900;
  const donchPeriod = options.donchPeriod || 5;
  const feeRate = options.feeRate || 0.0008;
  const fixedTpPct = options.fixedTpPct || 0; // 0 = use trailing only
  const timeFilter = options.timeFilter !== false;
  const lookbackBars = options.lookbackBars || 60;
  const candleIntervalMs = options.candleIntervalMs || 60000;

  const allTrades = [];
  const openPositions = [];

  // Build unified timeline
  const allTimestamps = new Set();
  for (const [, candles] of candlesBySymbol) {
    for (const c of candles) allTimestamps.add(c[0]);
  }
  const sortedTimes = Array.from(allTimestamps).sort((a, b) => a - b);

  // Index candles
  const candleIndex = new Map();
  for (const [sym, candles] of candlesBySymbol) {
    const idx = new Map();
    for (let i = 0; i < candles.length; i++) idx.set(candles[i][0], i);
    candleIndex.set(sym, idx);
  }

  let dayStart = 0, dayPnl = 0, dayLocked = false;

  for (const ts of sortedTimes) {
    const dayMs = ts - (ts % 86400000);
    if (dayMs !== dayStart) { dayStart = dayMs; dayPnl = 0; dayLocked = false; }
    if (dayLocked) continue;

    // Check exits
    for (let i = openPositions.length - 1; i >= 0; i--) {
      const pos = openPositions[i];
      const symCandles = candlesBySymbol.get(pos.symbol);
      const symIdx = candleIndex.get(pos.symbol);
      if (!symCandles || !symIdx) continue;
      const ci = symIdx.get(ts);
      if (ci === undefined) continue;
      const candle = symCandles[ci];
      const price = candle[4]; // close
      const elapsed = (ts - pos.entryTime) / 1000;

      let exitPrice = 0, exitReason = null;

      // SL check (use high/low wicks)
      if (pos.side === 'long' && candle[3] <= pos.slPrice) {
        exitPrice = pos.slPrice; exitReason = 'sl';
      } else if (pos.side === 'short' && candle[2] >= pos.slPrice) {
        exitPrice = pos.slPrice; exitReason = 'sl';
      }
      // Fixed TP check
      else if (fixedTpPct > 0) {
        const tpTarget = pos.side === 'long'
          ? pos.entryPrice * (1 + fixedTpPct)
          : pos.entryPrice * (1 - fixedTpPct);
        if (pos.side === 'long' && candle[2] >= tpTarget) {
          exitPrice = tpTarget; exitReason = 'tp';
        } else if (pos.side === 'short' && candle[3] <= tpTarget) {
          exitPrice = tpTarget; exitReason = 'tp';
        }
      }

      // Trailing TP (only if no fixed TP already triggered)
      if (!exitReason) {
        if (pos.side === 'long') {
          if (price > pos.tpAnchor) pos.tpAnchor = price;
          if (candle[2] > pos.tpAnchor) pos.tpAnchor = candle[2]; // use wick high
          const trail = pos.tpAnchor * (1 - tpPct);
          if (price <= trail && pos.tpAnchor > pos.entryPrice * (1 + slPct * 0.5)) {
            exitPrice = price; exitReason = 'tp';
          }
        } else {
          if (price < pos.tpAnchor) pos.tpAnchor = price;
          if (candle[3] < pos.tpAnchor) pos.tpAnchor = candle[3];
          const trail = pos.tpAnchor * (1 + tpPct);
          if (price >= trail && pos.tpAnchor < pos.entryPrice * (1 - slPct * 0.5)) {
            exitPrice = price; exitReason = 'tp';
          }
        }
      }

      // Timeout
      if (!exitReason && elapsed >= maxTimeSec) {
        exitPrice = price; exitReason = 'timeout';
      }

      if (exitReason) {
        const rawPnl = pos.side === 'long'
          ? (exitPrice - pos.entryPrice) / pos.entryPrice
          : (pos.entryPrice - exitPrice) / pos.entryPrice;
        const netPnl = (rawPnl * lev) - (feeRate * 2);
        allTrades.push({
          symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice,
          exitPrice, entryTime: pos.entryTime, exitTime: ts,
          pnlPct: netPnl * 100, exitReason,
        });
        dayPnl += netPnl;
        if (dayPnl <= -preset.maxDailyLoss) dayLocked = true;
        openPositions.splice(i, 1);
      }
    }

    if (dayLocked) continue;
    if (openPositions.length >= maxPos) continue;

    // Time filter: skip low-liquidity hours
    if (timeFilter) {
      const hour = new Date(ts).getUTCHours();
      if (hour >= 21 || hour < 1) continue;
    }

    // Check entries
    for (const [sym, candles] of candlesBySymbol) {
      if (openPositions.length >= maxPos) break;
      if (openPositions.some(p => p.symbol === sym)) continue;

      const symIdx = candleIndex.get(sym);
      if (!symIdx) continue;
      const ci = symIdx.get(ts);
      if (ci === undefined || ci < lookbackBars) continue;

      const lookback = candles.slice(Math.max(0, ci - lookbackBars), ci);
      if (lookback.length < 25) continue;
      const current = candles[ci];

      // Volume filter
      const recentVols = lookback.slice(-10);
      const avgRecent = recentVols.reduce((s, c) => s + c[5], 0) / recentVols.length;
      if (avgRecent < 1) continue;

      const sig = signalFn(lookback, current[4], current[5], donchPeriod, volMul, atrMin);
      if (sig === 'none') continue;

      const entry = current[4];
      const sl = sig === 'long' ? entry * (1 - slPct) : entry * (1 + slPct);
      openPositions.push({ symbol: sym, side: sig, entryPrice: entry, entryTime: ts, tpAnchor: entry, slPrice: sl });
    }
  }

  // Force close remaining
  for (const pos of openPositions) {
    const symCandles = candlesBySymbol.get(pos.symbol);
    if (!symCandles || !symCandles.length) continue;
    const last = symCandles[symCandles.length - 1];
    const rawPnl = pos.side === 'long'
      ? (last[4] - pos.entryPrice) / pos.entryPrice
      : (pos.entryPrice - last[4]) / pos.entryPrice;
    allTrades.push({
      symbol: pos.symbol, side: pos.side, entryPrice: pos.entryPrice,
      exitPrice: last[4], entryTime: pos.entryTime, exitTime: last[0],
      pnlPct: ((rawPnl * lev) - feeRate * 2) * 100, exitReason: 'timeout',
    });
  }

  // Metrics
  const wins = allTrades.filter(t => t.pnlPct > 0).length;
  const grossProfit = allTrades.filter(t => t.pnlPct > 0).reduce((s, t) => s + t.pnlPct, 0);
  const grossLoss = Math.abs(allTrades.filter(t => t.pnlPct <= 0).reduce((s, t) => s + t.pnlPct, 0));
  const pf = grossLoss > 0 ? grossProfit / grossLoss : (grossProfit > 0 ? 999 : 0);

  let eq = 100, peak = 100, maxDD = 0;
  const rets = [];
  for (const t of allTrades.sort((a, b) => a.exitTime - b.exitTime)) {
    eq *= (1 + t.pnlPct / 100);
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDD) maxDD = dd;
    rets.push(t.pnlPct / 100);
  }
  const avgR = rets.length ? rets.reduce((s,r) => s+r, 0) / rets.length : 0;
  const stdR = rets.length > 1 ? Math.sqrt(rets.reduce((s,r) => s+(r-avgR)**2, 0)/(rets.length-1)) : 0;
  const sharpe = stdR > 0 ? (avgR / stdR) * Math.sqrt(rets.length) : 0;

  const byReason = { tp: 0, sl: 0, timeout: 0 };
  allTrades.forEach(t => byReason[t.exitReason]++);

  return {
    preset: presetKey, totalTrades: allTrades.length, wins, losses: allTrades.length - wins,
    winRate: allTrades.length > 0 ? wins / allTrades.length : 0,
    totalReturnPct: eq - 100, maxDrawdownPct: maxDD * 100, profitFactor: pf,
    avgTradePnlPct: allTrades.length > 0 ? allTrades.reduce((s,t) => s+t.pnlPct, 0) / allTrades.length : 0,
    sharpe, byReason, trades: allTrades,
  };
}

// ── Candle Fetchers ─────────────────────────────────────────────────────────

async function fetchCandlesCcxt(exchange, symbol, timeframe, sinceMs, untilMs) {
  const all = [];
  let since = sinceMs;
  const intervalMs = timeframe === '5m' ? 300000 : 60000;
  while (since < untilMs) {
    const raw = await exchange.fetchOHLCV(symbol, timeframe, since, 1000);
    if (!raw || !raw.length) break;
    for (const c of raw) {
      if (c[0] >= untilMs) break;
      all.push([c[0], c[1], c[2], c[3], c[4], c[5]]);
    }
    const last = raw[raw.length - 1][0];
    if (last <= since) break;
    since = last + intervalMs;
    await new Promise(r => setTimeout(r, 250));
  }
  return all;
}

function weexFetch(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); } catch(e) { reject(e); }
      });
    }).on('error', reject);
  });
}

async function fetchCandlesWeex(symbol, timeframe, limit) {
  // WEEX candle endpoint: /capi/v2/market/candles
  // No 'since' param — only returns latest N candles
  const granMap = { '1m': '1m', '5m': '5m', '15m': '15m', '1h': '1h' };
  const gran = granMap[timeframe] || '1m';
  const maxLimit = Math.min(limit || 1000, 1000);
  const pubSym = `cmt_${symbol.toLowerCase()}`;
  const url = `https://api-contract.weex.com/capi/v2/market/candles?symbol=${pubSym}&granularity=${gran}&limit=${maxLimit}`;

  const resp = await weexFetch(url);
  const rows = Array.isArray(resp) ? resp : (resp && resp.data ? resp.data : []);

  return rows
    .map(item => Array.isArray(item && item.value) ? item.value : item)
    .filter(item => Array.isArray(item) && item.length >= 6)
    .map(item => [Number(item[0]), Number(item[1]), Number(item[2]), Number(item[3]), Number(item[4]), Number(item[5] || 0)])
    .filter(item => isFinite(item[0]))
    .sort((a, b) => a[0] - b[0]);
}

// WEEX: paginate to get ~N candles by repeated calls with shrinking time window
async function fetchCandlesWeexPaginated(symbol, timeframe, targetCandles) {
  const intervalMs = timeframe === '5m' ? 300000 : 60000;
  const all = new Map(); // timeMs → candle (dedup)

  // WEEX returns latest candles — we'll query multiple times
  // First get latest 1000
  let candles = await fetchCandlesWeex(symbol, timeframe, 1000);
  for (const c of candles) all.set(c[0], c);
  console.log(`    WEEX ${symbol} ${timeframe}: got ${candles.length} initial candles`);

  if (candles.length >= targetCandles || candles.length === 0) {
    return Array.from(all.values()).sort((a, b) => a[0] - b[0]);
  }

  // WEEX likely only returns 1000 max — that's what we get
  // For 1m: 1000 candles ≈ 16.7h, for 5m: 1000 candles ≈ 3.5 days
  // Not enough for months — we'll use what we can get

  return Array.from(all.values()).sort((a, b) => a[0] - b[0]);
}

// ── Formatting ──────────────────────────────────────────────────────────────

function fmtRow(r) {
  const label = PRESETS[r.preset].label.padEnd(15);
  const trades = String(r.totalTrades).padStart(6);
  const wr = `${(r.winRate * 100).toFixed(1)}%`.padStart(7);
  const ret = `${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(1)}%`.padStart(9);
  const dd = `${r.maxDrawdownPct.toFixed(1)}%`.padStart(7);
  const pf = (r.profitFactor >= 999 ? '∞' : r.profitFactor.toFixed(2)).padStart(6);
  const sh = r.sharpe.toFixed(2).padStart(6);
  const avg = `${r.avgTradePnlPct >= 0 ? '+' : ''}${r.avgTradePnlPct.toFixed(3)}%`.padStart(8);
  const tp = String(r.byReason.tp).padStart(4);
  const sl = String(r.byReason.sl).padStart(4);
  const to = String(r.byReason.timeout).padStart(5);
  return `${label}| ${trades} | ${wr} | ${ret} | ${dd} | ${pf} | ${sh} | ${avg} | ${tp}/${sl}/${to}`;
}

function printResults(title, results) {
  console.log('');
  console.log(`═══ ${title} ${'═'.repeat(Math.max(0, 90 - title.length))}`);
  console.log('Preset          | Trades | WinRate | Return    | MaxDD   |     PF | Sharpe | AvgTrade | TP/SL/Timeout');
  console.log('────────────────|────────|─────────|───────────|─────────|────────|────────|──────────|──────────────');
  for (const r of results) console.log(fmtRow(r));
  console.log('');
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  const now = Date.now();
  const allResults = {};

  console.log('╔══════════════════════════════════════════════════════════════╗');
  console.log('║  Razgon Comprehensive Backtest — Multi-Variant Comparison   ║');
  console.log('╚══════════════════════════════════════════════════════════════╝');
  console.log(`Time: ${new Date().toISOString()}`);
  console.log(`Symbols: ${SYMBOLS_CCXT.join(', ')}`);
  console.log('');

  const mexc = new ccxt.mexc({ enableRateLimit: true });
  const presetKeys = ['low', 'mid', 'high'];

  // ──────────────────────────────────────────────────────────────────────
  // VARIANT A: 1m / 1 month / MEXC / Original strategy (donch=5)
  // ──────────────────────────────────────────────────────────────────────
  console.log('>>> Variant A: 1m / 1mo / MEXC / Original (donch=5)');
  {
    const since = now - 30 * 86400000;
    const data = new Map();
    for (const sym of SYMBOLS_CCXT) {
      console.log(`  Fetching ${sym} 1m...`);
      const c = await fetchCandlesCcxt(mexc, sym, '1m', since, now);
      console.log(`    → ${c.length} candles`);
      if (c.length > 0) data.set(sym, c);
    }
    const results = presetKeys.map(p => runBacktest(data, p, signalOriginal, {
      donchPeriod: 5, maxTimeSec: 900, feeRate: 0.0008, candleIntervalMs: 60000, lookbackBars: 60,
    }));
    allResults['A_1m_MEXC_orig'] = results;
    printResults('A: 1m / 1mo / MEXC / Original (donch=5)', results);
  }

  // ──────────────────────────────────────────────────────────────────────
  // VARIANT B: 1m / 1 month / MEXC / Optimized (donch=15, RSI, vol required, fixed TP + trail)
  // ──────────────────────────────────────────────────────────────────────
  console.log('>>> Variant B: 1m / 1mo / MEXC / Optimized (donch=15, RSI, strictVol)');
  {
    // Re-use candles from A — same data
    const since = now - 30 * 86400000;
    const data = new Map();
    for (const sym of SYMBOLS_CCXT) {
      console.log(`  Fetching ${sym} 1m...`);
      const c = await fetchCandlesCcxt(mexc, sym, '1m', since, now);
      console.log(`    → ${c.length} candles`);
      if (c.length > 0) data.set(sym, c);
    }
    const results = presetKeys.map(p => runBacktest(data, p, signalOptimized, {
      donchPeriod: 15, maxTimeSec: 900, feeRate: 0.0008, fixedTpPct: 0.003, // 0.3% fixed TP
      candleIntervalMs: 60000, lookbackBars: 60,
    }));
    allResults['B_1m_MEXC_opt'] = results;
    printResults('B: 1m / 1mo / MEXC / Optimized (donch=15, RSI, fixedTP=0.3%)', results);
  }

  // ──────────────────────────────────────────────────────────────────────
  // VARIANT C: 5m / 3 months / MEXC / Adapted strategy
  // ──────────────────────────────────────────────────────────────────────
  console.log('>>> Variant C: 5m / 3mo / MEXC / Adapted (donch=12, RSI)');
  {
    const since = now - 90 * 86400000;
    const data = new Map();
    for (const sym of SYMBOLS_CCXT) {
      console.log(`  Fetching ${sym} 5m...`);
      const c = await fetchCandlesCcxt(mexc, sym, '5m', since, now);
      console.log(`    → ${c.length} candles (${(c.length / 288).toFixed(0)} days)`);
      if (c.length > 0) data.set(sym, c);
    }
    const results = presetKeys.map(p => runBacktest(data, p, signal5m, {
      donchPeriod: 12, // 12×5m = 1h lookback
      maxTimeSec: 3600, // 1h timeout for 5m
      feeRate: 0.0008,
      fixedTpPct: 0.005, // 0.5% fixed TP for 5m
      candleIntervalMs: 300000,
      lookbackBars: 60, // 60×5m = 5h
    }));
    allResults['C_5m_MEXC'] = results;
    printResults('C: 5m / 3mo / MEXC / Adapted (donch=12, timeout=1h, fixTP=0.5%)', results);
  }

  // ──────────────────────────────────────────────────────────────────────
  // VARIANT D: 1m / WEEX / Optimized (limited candles ~1000)
  // ──────────────────────────────────────────────────────────────────────
  console.log('>>> Variant D: 1m / WEEX / Optimized');
  {
    const data = new Map();
    for (let i = 0; i < SYMBOLS_WEEX.length; i++) {
      const sym = SYMBOLS_WEEX[i];
      const ccxtSym = SYMBOLS_CCXT[i];
      console.log(`  Fetching WEEX ${sym} 1m...`);
      const c = await fetchCandlesWeexPaginated(sym, '1m', 1000);
      console.log(`    → ${c.length} candles (${(c.length/1440).toFixed(1)} days)`);
      if (c.length > 0) data.set(ccxtSym, c); // use same key as MEXC for comparison
      await new Promise(r => setTimeout(r, 300));
    }
    if (data.size > 0) {
      const results = presetKeys.map(p => runBacktest(data, p, signalOptimized, {
        donchPeriod: 15, maxTimeSec: 900, feeRate: 0.001, // WEEX taker=0.08%, maker=0.02%
        fixedTpPct: 0.003, candleIntervalMs: 60000, lookbackBars: 60,
      }));
      allResults['D_1m_WEEX'] = results;
      printResults('D: 1m / WEEX / Optimized (donch=15, RSI, fixedTP=0.3%)', results);
    } else {
      console.log('  ⚠ No WEEX candle data available');
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // VARIANT E: 5m / WEEX
  // ──────────────────────────────────────────────────────────────────────
  console.log('>>> Variant E: 5m / WEEX');
  {
    const data = new Map();
    for (let i = 0; i < SYMBOLS_WEEX.length; i++) {
      const sym = SYMBOLS_WEEX[i];
      const ccxtSym = SYMBOLS_CCXT[i];
      console.log(`  Fetching WEEX ${sym} 5m...`);
      const c = await fetchCandlesWeexPaginated(sym, '5m', 1000);
      console.log(`    → ${c.length} candles (${(c.length/288).toFixed(1)} days)`);
      if (c.length > 0) data.set(ccxtSym, c);
      await new Promise(r => setTimeout(r, 300));
    }
    if (data.size > 0) {
      const results = presetKeys.map(p => runBacktest(data, p, signal5m, {
        donchPeriod: 12, maxTimeSec: 3600, feeRate: 0.001,
        fixedTpPct: 0.005, candleIntervalMs: 300000, lookbackBars: 60,
      }));
      allResults['E_5m_WEEX'] = results;
      printResults('E: 5m / WEEX / Adapted (donch=12, timeout=1h, fixTP=0.5%)', results);
    } else {
      console.log('  ⚠ No WEEX 5m candle data available');
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // GRAND COMPARISON TABLE
  // ──────────────────────────────────────────────────────────────────────
  console.log('\n\n');
  console.log('╔════════════════════════════════════════════════════════════════════════════════════════╗');
  console.log('║                        GRAND COMPARISON — ALL VARIANTS                               ║');
  console.log('╚════════════════════════════════════════════════════════════════════════════════════════╝');
  console.log('');
  console.log('Variant                        | Preset      | Trades | WR     | Return    | MaxDD   | PF    | Sharpe');
  console.log('───────────────────────────────|─────────────|────────|────────|───────────|─────────|───────|───────');

  for (const [varKey, results] of Object.entries(allResults)) {
    for (const r of results) {
      const vLabel = varKey.replace(/_/g, ' ').padEnd(30);
      const pLabel = PRESETS[r.preset].label.padEnd(12);
      const trades = String(r.totalTrades).padStart(6);
      const wr = `${(r.winRate*100).toFixed(1)}%`.padStart(6);
      const ret = `${r.totalReturnPct >= 0 ? '+' : ''}${r.totalReturnPct.toFixed(1)}%`.padStart(9);
      const dd = `${r.maxDrawdownPct.toFixed(1)}%`.padStart(7);
      const pf = (r.profitFactor >= 999 ? '∞' : r.profitFactor.toFixed(2)).padStart(5);
      const sh = r.sharpe.toFixed(2).padStart(6);
      console.log(`${vLabel} | ${pLabel} | ${trades} | ${wr} | ${ret} | ${dd} | ${pf} | ${sh}`);
    }
    console.log('───────────────────────────────|─────────────|────────|────────|───────────|─────────|───────|───────');
  }

  // ── Best variant per preset ─────────────────────────────────────────
  console.log('\n>>> Best variant per preset (highest PF):');
  for (const p of presetKeys) {
    let best = null, bestVar = '';
    for (const [varKey, results] of Object.entries(allResults)) {
      const r = results.find(x => x.preset === p);
      if (r && (!best || r.profitFactor > best.profitFactor)) {
        best = r; bestVar = varKey;
      }
    }
    if (best) {
      console.log(`  ${PRESETS[p].label}: ${bestVar} — PF=${best.profitFactor.toFixed(2)}, WR=${(best.winRate*100).toFixed(1)}%, Ret=${best.totalReturnPct.toFixed(1)}%`);
    }
  }

  // Save results
  const saveData = {};
  for (const [key, results] of Object.entries(allResults)) {
    saveData[key] = results.map(r => ({
      preset: r.preset, label: PRESETS[r.preset].label,
      totalTrades: r.totalTrades, wins: r.wins, losses: r.losses,
      winRate: Math.round(r.winRate * 1000) / 10,
      totalReturnPct: Math.round(r.totalReturnPct * 100) / 100,
      maxDrawdownPct: Math.round(r.maxDrawdownPct * 100) / 100,
      profitFactor: Math.round(r.profitFactor * 100) / 100,
      sharpe: Math.round(r.sharpe * 100) / 100,
      avgTradePnlPct: Math.round(r.avgTradePnlPct * 1000) / 1000,
      byReason: r.byReason,
    }));
  }
  const outPath = __dirname ? (__dirname + '/razgon_bt_comparison.json') : '/tmp/razgon_bt_comparison.json';
  fs.writeFileSync(outPath, JSON.stringify(saveData, null, 2));
  console.log(`\nResults saved to ${outPath}`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

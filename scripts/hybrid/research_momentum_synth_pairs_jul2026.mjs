#!/usr/bin/env node
/**
 * Momentum scalp on SYNTHETIC ratio pairs — TF + param grid (close-exit = live parity).
 *
 *   cd backend && npm run build && node ../scripts/hybrid/research_momentum_synth_pairs_jul2026.mjs
 *
 * Env:
 *   API_KEY=BTDD_D1
 *   INTERVALS=15m,1h,4h
 *   PAIRS=INJUSDT/TIAUSDT,LINKUSDT/UNIUSDT,HBARUSDT/VETUSDT,SOLUSDT/AVAXUSDT,ATOMUSDT/DOTUSDT,NEARUSDT/FILUSDT,ONDOUSDT/TIAUSDT
 *   OUT_DIR=results/momentum_synth_jul2026
 *   EXIT_MODE=close|wick   (default close)
 *   QUICK=1                (smaller grid)
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);

const database = require(path.join(backendRoot, 'dist/utils/database.js'));
await database.initDB();
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const ms = require(path.join(backendRoot, 'dist/research/momentumScalpBacktest.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

const API_KEY = process.env.API_KEY || 'BTDD_D1';
const OUT = process.env.OUT_DIR || path.join(root, 'results', 'momentum_synth_jul2026');
const EXIT_MODE = process.env.EXIT_MODE === 'wick' ? 'wick' : 'close';
const QUICK = process.env.QUICK === '1';

const PAIRS = (process.env.PAIRS || [
  'INJUSDT/TIAUSDT',
  'LINKUSDT/UNIUSDT',
  'HBARUSDT/VETUSDT',
  'SOLUSDT/AVAXUSDT',
  'ATOMUSDT/DOTUSDT',
  'NEARUSDT/FILUSDT',
  'ONDOUSDT/TIAUSDT',
  'MANTAUSDT/APTUSDT',
].join(',')).split(',').map((s) => s.trim()).filter(Boolean);

const INTERVALS = (process.env.INTERVALS || '15m,1h,4h').split(',').map((s) => s.trim());

const WINDOWS = {
  full: { from: '2024-06-01', to: process.env.DATE_TO || '2026-07-08' },
  ep4: { from: '2026-05-01', to: '2026-06-30' },
  recent: { from: '2026-01-01', to: process.env.DATE_TO || '2026-07-08' },
};

const EMA_FAST = QUICK ? [8] : [5, 8, 12];
const EMA_SLOW = QUICK ? [21] : [21, 26, 34];
const ADX_MIN = QUICK ? [20, 25] : [15, 20, 25, 30];
const TP = QUICK ? [2.0, 3.0] : [1.5, 2.0, 3.0, 4.0];
const SL = QUICK ? [1.2, 2.0] : [1.0, 1.2, 2.0];
const SIDE_MODES = QUICK ? ['both'] : ['both', 'long', 'short'];

const barMinutes = (iv) => {
  if (iv === '15m') return 15;
  if (iv === '4h') return 240;
  if (iv.endsWith('h')) return parseInt(iv, 10) * 60;
  if (iv.endsWith('d')) return parseInt(iv, 10) * 1440;
  return 60;
};

const parsePair = (p) => {
  const [base, quote] = p.split('/').map((x) => x.trim().toUpperCase());
  return { base, quote, key: `${base}/${quote}` };
};

fs.mkdirSync(OUT, { recursive: true });
await ensureExchangeClientInitialized(API_KEY);

const rows = [];
const candleCache = new Map();

for (const interval of INTERVALS) {
  const bm = barMinutes(interval);
  for (const pairStr of PAIRS) {
    const { base, quote, key } = parsePair(pairStr);
    const cacheKey = `${key}|${interval}`;
    let candles = candleCache.get(cacheKey);
    if (!candles) {
      try {
        candles = await wickData.fetchSyntheticCandles(API_KEY, base, quote, interval, {
          startMs: Date.parse(WINDOWS.full.from),
          endMs: Date.parse(`${WINDOWS.full.to}T23:59:59Z`),
          limit: 8000,
        });
      } catch (e) {
        console.warn('skip', key, interval, e.message);
        continue;
      }
      candleCache.set(cacheKey, candles);
    }
    if (!candles || candles.length < 120) {
      console.warn('too few bars', key, interval, candles?.length || 0);
      continue;
    }
    console.log(`synth momentum ${key} ${interval}: ${candles.length} bars exit=${EXIT_MODE}`);

    for (const emaFastPeriod of EMA_FAST) {
      for (const emaSlowPeriod of EMA_SLOW) {
        if (emaFastPeriod >= emaSlowPeriod) continue;
        for (const adxMin of ADX_MIN) {
          for (const tpPercent of TP) {
            for (const slPercent of SL) {
              if (slPercent >= tpPercent) continue;
              for (const sideMode of SIDE_MODES) {
                const cfg = {
                  ...ms.tvTrendScalpPreset(),
                  emaFastPeriod,
                  emaSlowPeriod,
                  adxPeriod: 14,
                  adxMin,
                  tpPercent,
                  slPercent,
                  sideMode,
                  exitMode: EXIT_MODE,
                  exitOnOppositeCross: true,
                  barMinutes: bm,
                  initialBalance: 1000,
                  positionFraction: 1,
                  commissionPercent: 0.1,
                  slippagePercent: 0.05,
                };
                const res = ms.runMomentumScalpBacktest(candles, cfg);
                const full = res.summary;
                const ep4 = ms.summarizeWindow(
                  res.trades,
                  Date.parse(WINDOWS.ep4.from),
                  Date.parse(`${WINDOWS.ep4.to}T23:59:59Z`),
                  cfg.initialBalance,
                );
                const recent = ms.summarizeWindow(
                  res.trades,
                  Date.parse(WINDOWS.recent.from),
                  Date.parse(`${WINDOWS.recent.to}T23:59:59Z`),
                  cfg.initialBalance,
                );
                if (full.tradesCount < 5) continue;
                rows.push({
                  pair: key,
                  interval,
                  exitMode: EXIT_MODE,
                  emaFastPeriod,
                  emaSlowPeriod,
                  adxMin,
                  tpPercent,
                  slPercent,
                  sideMode,
                  bars: candles.length,
                  trades: full.tradesCount,
                  wr: full.winRatePercent,
                  pf: full.profitFactor,
                  ret: full.totalReturnPercent,
                  dd: full.maxDrawdownPercent,
                  ep4_trades: ep4.trades,
                  ep4_ret: ep4.totalReturnPercent,
                  ep4_dd: ep4.maxDrawdownPercent,
                  ep4_pf: ep4.profitFactor,
                  recent_trades: recent.trades,
                  recent_ret: recent.totalReturnPercent,
                  recent_dd: recent.maxDrawdownPercent,
                  recent_pf: recent.profitFactor,
                  score: (full.profitFactor || 0) * Math.log10(1 + full.tradesCount)
                    * (full.totalReturnPercent > 0 ? 1 : 0.2)
                    / Math.max(1, full.maxDrawdownPercent / 10),
                });
              }
            }
          }
        }
      }
    }
  }
}

rows.sort((a, b) => b.score - a.score);
const top = rows.slice(0, 40);
const byInterval = {};
for (const iv of INTERVALS) {
  byInterval[iv] = rows.filter((r) => r.interval === iv).slice(0, 15);
}
const baseline = rows.filter((r) =>
  r.emaFastPeriod === 8 && r.emaSlowPeriod === 21 && r.adxMin === 20
  && r.tpPercent === 2 && r.slPercent === 1.2 && r.sideMode === 'both');

const out = {
  generatedAt: new Date().toISOString(),
  exitMode: EXIT_MODE,
  windows: WINDOWS,
  pairs: PAIRS,
  intervals: INTERVALS,
  nRows: rows.length,
  top40: top,
  topByInterval: byInterval,
  baseline_8_21_adx20_tp2_sl1_2: baseline.sort((a, b) => b.ret - a.ret),
};

fs.mkdirSync(OUT, { recursive: true });
const outPath = path.join(OUT, `momentum_synth_${EXIT_MODE}.json`);
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

console.log('\n=== TOP 15 (all) ===');
console.table(top.slice(0, 15).map((r) => ({
  pair: r.pair, iv: r.interval, ema: `${r.emaFastPeriod}/${r.emaSlowPeriod}`,
  adx: r.adxMin, tp: r.tpPercent, sl: r.slPercent, side: r.sideMode,
  n: r.trades, pf: Number(r.pf?.toFixed?.(2) ?? r.pf),
  ret: Number(r.ret?.toFixed?.(1) ?? r.ret),
  dd: Number(r.dd?.toFixed?.(1) ?? r.dd),
  ep4: Number(r.ep4_ret?.toFixed?.(1) ?? r.ep4_ret),
})));

console.log('\n=== BASELINE 8/21 ADX20 TP2 SL1.2 both ===');
console.table(baseline.map((r) => ({
  pair: r.pair, iv: r.interval, n: r.trades,
  pf: Number(r.pf?.toFixed?.(2) ?? r.pf),
  ret: Number(r.ret?.toFixed?.(1) ?? r.ret),
  dd: Number(r.dd?.toFixed?.(1) ?? r.dd),
  recent: Number(r.recent_ret?.toFixed?.(1) ?? r.recent_ret),
})));

console.log(`\nwrote ${outPath} (${rows.length} rows)`);

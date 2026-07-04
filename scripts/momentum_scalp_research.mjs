#!/usr/bin/env node
/**
 * TV trend scalp (EMA cross + ADX): param grid on mono liquid symbols.
 *   cd backend && npm run build && node ../scripts/momentum_scalp_research.mjs
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);

const database = require(path.join(backendRoot, 'dist/utils/database.js'));
await database.initDB();
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const ms = require(path.join(backendRoot, 'dist/research/momentumScalpBacktest.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

const API_KEY = process.env.API_KEY || 'BTDD_D1';
const OUT = process.env.OUT_DIR || path.join(root, 'results', 'ep4_burst_research');

const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SUIUSDT,DOGEUSDT,TRXUSDT,CRVUSDT,SOLUSDT').split(',').map((s) => s.trim());
const INTERVALS = (process.env.INTERVALS || '1h,15m').split(',').map((s) => s.trim());

const WINDOWS = {
  ep4: { from: '2026-05-01', to: '2026-06-30' },
  ep3: { from: '2025-07-24', to: '2025-10-11' },
  full: { from: '2024-06-01', to: process.env.DATE_TO || '2026-07-03' },
};

const EMA_FAST = [8, 9, 12];
const EMA_SLOW = [21, 26];
const ADX_MIN = [20, 25, 30];
const TP = [1.0, 1.5, 2.0];
const SL = [0.8, 1.2];

fs.mkdirSync(OUT, { recursive: true });
await ensureExchangeClientInitialized(API_KEY);

const barMinutes = (iv) => {
  if (iv === '15m') return 15;
  if (iv.endsWith('h')) return parseInt(iv, 10) * 60;
  return 60;
};

const rows = [];
for (const interval of INTERVALS) {
  const bm = barMinutes(interval);
  for (const sym of SYMBOLS) {
    let candles;
    try {
      candles = await wickData.fetchMonoCandles(API_KEY, sym, interval, {
        startMs: Date.parse(WINDOWS.full.from),
        endMs: Date.parse(`${WINDOWS.full.to}T23:59:59Z`),
        limit: 8000,
      });
    } catch (e) {
      console.warn('skip', sym, e.message);
      continue;
    }
    if (candles.length < 100) continue;
    console.log(`TV scalp ${sym} ${interval}: ${candles.length} bars`);

    for (const emaFastPeriod of EMA_FAST) {
      for (const emaSlowPeriod of EMA_SLOW) {
        if (emaFastPeriod >= emaSlowPeriod) continue;
        for (const adxMin of ADX_MIN) {
          for (const tpPercent of TP) {
            for (const slPercent of SL) {
              for (const sideMode of ['both', 'long', 'short']) {
                const cfg = {
                  ...ms.tvTrendScalpPreset(),
                  emaFastPeriod,
                  emaSlowPeriod,
                  adxMin,
                  tpPercent,
                  slPercent,
                  sideMode,
                  barMinutes: bm,
                  initialBalance: 1000,
                  positionFraction: 1,
                };
                const res = ms.runMomentumScalpBacktest(candles, cfg);
                const ep4 = ms.summarizeWindow(
                  res.trades,
                  Date.parse(WINDOWS.ep4.from),
                  Date.parse(`${WINDOWS.ep4.to}T23:59:59Z`),
                  cfg.initialBalance,
                );
                const ep3 = ms.summarizeWindow(
                  res.trades,
                  Date.parse(WINDOWS.ep3.from),
                  Date.parse(`${WINDOWS.ep3.to}T23:59:59Z`),
                  cfg.initialBalance,
                );
                if (ep4.trades === 0 && ep3.trades === 0) continue;
                rows.push({
                  sym,
                  interval,
                  emaFastPeriod,
                  emaSlowPeriod,
                  adxMin,
                  tpPercent,
                  slPercent,
                  sideMode,
                  ep4,
                  ep3,
                  full: {
                    ret: res.summary.totalReturnPercent,
                    dd: res.summary.maxDrawdownPercent,
                    trades: res.summary.tradesCount,
                    pf: res.summary.profitFactor,
                  },
                });
              }
            }
          }
        }
      }
    }
  }
}

rows.sort((a, b) => (b.ep4.trades - a.ep4.trades) || (b.ep4.ret - a.ep4.ret));
const ep4Winners = rows.filter((r) => r.ep4.ret > 0 && r.ep4.trades >= 10);
const dualWinners = rows.filter((r) => r.ep4.ret > 0 && r.ep3.ret > 0 && r.ep4.trades >= 8);

const out = {
  generatedAt: new Date().toISOString(),
  phase: 'tv_momentum_scalp',
  pineMapping: {
    name: 'EMA crossover + ADX/DI trend filter',
    emaFast: '8-12',
    emaSlow: '21-26',
    adxPeriod: 14,
    adxMin: '20-30',
    tpSl: 'fixed % burst',
  },
  gridSize: rows.length,
  ep4Winners: ep4Winners.slice(0, 40),
  ep3ep4Winners: dualWinners.slice(0, 25),
  topByEp4Trades: rows.slice(0, 30),
};

fs.writeFileSync(path.join(OUT, 'phase_tv_momentum_scalp.json'), JSON.stringify(out, null, 2));
console.log(`TV scalp done: grid=${rows.length} ep4Win=${ep4Winners.length} dual=${dualWinners.length}`);
console.log(`wrote ${path.join(OUT, 'phase_tv_momentum_scalp.json')}`);

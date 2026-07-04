#!/usr/bin/env node
/**
 * Phase 0: wick-retest param grid on EP3/EP4/full windows.
 *   cd backend && npm run build && node ../scripts/ep4_wick_grid.mjs
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
const wick = require(path.join(backendRoot, 'dist/research/wickRetestBacktest.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

const API_KEY = process.env.API_KEY || 'BTDD_D1';
const OUT = process.env.OUT_DIR || path.join(root, 'results', 'ep4_burst_research');
const SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,SUIUSDT,DOGEUSDT,TRXUSDT,CRVUSDT,SOLUSDT').split(',').map((s) => s.trim());
const INTERVALS = (process.env.INTERVALS || '1h,15m').split(',').map((s) => s.trim());

const WINDOWS = {
  ep4: { from: '2026-05-01', to: '2026-06-30', label: 'EP4' },
  ep3: { from: '2025-07-24', to: '2025-10-11', label: 'EP3' },
  full: { from: '2024-06-01', to: process.env.DATE_TO || '2026-07-03', label: 'full' },
};

const SHADOWS = [1.0, 1.5, 2.0, 2.5, 3.0];
const SIZE_GAPS = [2, 3, 5];
const WAIT_DAYS = [0, 0.25, 0.5];
const SIDES = ['both', 'short', 'long'];

fs.mkdirSync(OUT, { recursive: true });
await ensureExchangeClientInitialized(API_KEY);

const barMinutes = (iv) => (iv.endsWith('h') ? parseInt(iv, 10) * 60 : iv === '15m' ? 15 : 60);

const sliceTrades = (trades, t0, t1) =>
  trades.filter((t) => t.exitTime >= t0 && t.exitTime <= t1);

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
      console.warn('skip', sym, interval, e.message);
      continue;
    }
    if (candles.length < 80) continue;
    console.log(`${sym} ${interval}: ${candles.length} bars`);

    for (const shadowPercent of SHADOWS) {
      for (const sizeCandlePercent of SIZE_GAPS) {
        for (const daysToWait of WAIT_DAYS) {
          for (const sideMode of SIDES) {
            const base = {
              ...wick.screenshotWickConfig(),
              barMinutes: bm,
              shadowPercent,
              sizeCandlePercent,
              daysToWait,
              sideMode,
              commissionPercent: 0.1,
              slippagePercent: 0.05,
              initialBalance: 1000,
              positionFraction: 1,
            };
            const res = wick.runWickRetestBacktest(candles, base);
            const ep4m = sliceTrades(res.trades, Date.parse(WINDOWS.ep4.from), Date.parse(`${WINDOWS.ep4.to}T23:59:59Z`));
            const ep3m = sliceTrades(res.trades, Date.parse(WINDOWS.ep3.from), Date.parse(`${WINDOWS.ep3.to}T23:59:59Z`));
            const ep4Net = ep4m.reduce((s, t) => s + t.netPnl, 0);
            const ep3Net = ep3m.reduce((s, t) => s + t.netPnl, 0);
            const ep4 = {
              ret: base.initialBalance > 0 ? (ep4Net / base.initialBalance) * 100 : 0,
              trades: ep4m.length,
            };
            const ep3 = {
              ret: base.initialBalance > 0 ? (ep3Net / base.initialBalance) * 100 : 0,
              trades: ep3m.length,
            };
            if (ep4.trades === 0 && ep3.trades === 0) continue;
            rows.push({
              sym,
              interval,
              shadowPercent,
              sizeCandlePercent,
              daysToWait,
              sideMode,
              ep4,
              ep3,
              fullRet: res.summary.totalReturnPercent,
              fullTrades: res.summary.tradesCount,
              pf: res.summary.profitFactor,
              dd: res.summary.maxDrawdownPercent,
            });
          }
        }
      }
    }
  }
}

rows.sort((a, b) => (b.ep4.trades - a.ep4.trades) || (b.ep4.ret - a.ep4.ret));
const positiveEp4 = rows.filter((r) => r.ep4.ret > 0 && r.ep4.trades >= 8);
const positiveBoth = rows.filter((r) => r.ep4.ret > 0 && r.ep3.ret > 0 && r.ep4.trades >= 6 && r.ep3.trades >= 6);

const out = {
  generatedAt: new Date().toISOString(),
  phase: 0,
  gridSize: rows.length,
  positiveEp4: positiveEp4.slice(0, 30),
  positiveEp3AndEp4: positiveBoth.slice(0, 20),
  topByEp4Trades: rows.slice(0, 25),
  goPhase1: positiveEp4.length > 0 || rows.some((r) => r.ep4.trades >= 5),
};

fs.writeFileSync(path.join(OUT, 'phase0_wick_grid.json'), JSON.stringify(out, null, 2));
console.log(`Phase0 done: grid=${rows.length} ep4+=${positiveEp4.length} goPhase1=${out.goPhase1}`);
console.log(`wrote ${path.join(OUT, 'phase0_wick_grid.json')}`);

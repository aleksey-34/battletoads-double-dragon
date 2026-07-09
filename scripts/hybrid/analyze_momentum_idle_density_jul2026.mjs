#!/usr/bin/env node
/**
 * Momentum scalp: idle vs dense periods over full backtest window (per symbol).
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(backendRoot, 'dist/utils/database.js'));
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const ms = require(path.join(backendRoot, 'dist/research/momentumScalpBacktest.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

await database.initDB();

const API_KEY = process.env.API_KEY || 'artursk-6323499563-api';
const FROM = process.env.DATE_FROM || '2024-06-01';
const TO = process.env.DATE_TO || '2026-07-09';
const SYMBOLS = (process.env.SYMBOLS || 'INJUSDT,SUIUSDT,DOGEUSDT,SOLUSDT,NEARUSDT,LINKUSDT,VETUSDT,HBARUSDT,TIAUSDT,ATOMUSDT').split(',').map((s) => s.trim());
const INTERVAL = process.env.INTERVAL || '15m';

const cfg = {
  ...ms.tvTrendScalpPreset(),
  ...ms.tvBurstEp4Preset(),
  barMinutes: 15,
  emaFastPeriod: 8,
  emaSlowPeriod: 21,
  adxMin: 20,
  tpPercent: 2.0,
  slPercent: 1.2,
  exitOnOppositeCross: true,
  sideMode: 'both',
};

await ensureExchangeClientInitialized(API_KEY);

const dayMs = 24 * 3600 * 1000;
const summarizeGaps = (trades) => {
  if (!trades.length) {
    return { trades: 0, maxIdleDays: null, p50IdleDays: null, maxTradesPerDay: 0, p90TradesPerDay: 0 };
  }
  const sorted = [...trades].sort((a, b) => a.entryTime - b.entryTime);
  const gaps = [];
  for (let i = 1; i < sorted.length; i += 1) {
    gaps.push((sorted[i].entryTime - sorted[i - 1].entryTime) / dayMs);
  }
  gaps.sort((a, b) => a - b);
  const byDay = new Map();
  for (const t of sorted) {
    const d = new Date(t.entryTime).toISOString().slice(0, 10);
    byDay.set(d, (byDay.get(d) || 0) + 1);
  }
  const perDay = [...byDay.values()].sort((a, b) => a - b);
  const p = (arr, q) => arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))];
  return {
    trades: sorted.length,
    maxIdleDays: gaps.length ? Math.max(...gaps).toFixed(1) : '0',
    p50IdleDays: gaps.length ? p(gaps, 0.5).toFixed(1) : '0',
    p90IdleDays: gaps.length ? p(gaps, 0.9).toFixed(1) : '0',
    maxTradesPerDay: perDay.length ? Math.max(...perDay) : 0,
    p90TradesPerDay: perDay.length ? p(perDay, 0.9) : 0,
    activeDays: byDay.size,
    windowDays: ((Date.parse(`${TO}T00:00:00Z`) - Date.parse(`${FROM}T00:00:00Z`)) / dayMs).toFixed(0),
  };
};

const fleet = [];
for (const sym of SYMBOLS) {
  let candles;
  try {
    candles = await wickData.fetchMonoCandles(API_KEY, sym, INTERVAL, {
      startMs: Date.parse(`${FROM}T00:00:00Z`),
      endMs: Date.parse(`${TO}T23:59:59Z`),
      limit: 12000,
    });
  } catch (e) {
    fleet.push({ symbol: sym, error: e.message });
    continue;
  }
  const result = ms.runMomentumScalpBacktest(candles, cfg);
  fleet.push({ symbol: sym, bars: candles.length, ...summarizeGaps(result.trades) });
  console.log(sym, fleet[fleet.length - 1]);
}

const allTrades = [];
for (const sym of SYMBOLS) {
  const row = fleet.find((r) => r.symbol === sym && r.trades);
  if (!row) continue;
}
// portfolio-level: merge all symbol backtests
let mergedTrades = [];
for (const sym of SYMBOLS) {
  try {
    const candles = await wickData.fetchMonoCandles(API_KEY, sym, INTERVAL, {
      startMs: Date.parse(`${FROM}T00:00:00Z`),
      endMs: Date.parse(`${TO}T23:59:59Z`),
      limit: 12000,
    });
    if (candles.length < 100) continue;
    mergedTrades = mergedTrades.concat(ms.runMomentumScalpBacktest(candles, cfg).trades);
  } catch { /* skip */ }
}

const portfolio = summarizeGaps(mergedTrades);
const out = { generatedAt: new Date().toISOString(), from: FROM, to: TO, interval: INTERVAL, cfg, perSymbol: fleet, portfolio };
console.log('\nPORTFOLIO', portfolio);
import fs from 'fs';
const outPath = process.env.OUT || path.join(backendRoot, '..', 'tmp', 'momentum_idle_density_jul2026.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(out, null, 2));

#!/usr/bin/env node
/**
 * Portfolio sim for TV cloud spread (honest shared-equity, hybrid candles).
 *   node sim_tv_cloud_portfolio.mjs <symbols.json> <lot> <op> [out.json]
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..', '..');
const backendRoot = path.join(root, 'backend');
const require = createRequire(import.meta.url);
const hybrid = require(path.join(backendRoot, 'dist/bot/hybridCandleStore.js'));
const ms = require(path.join(backendRoot, 'dist/research/momentumScalpBacktest.js'));

const symbols = JSON.parse(fs.readFileSync(process.argv[2], 'utf-8'));
const lot = Number(process.argv[3] || 15);
const op = Number(process.argv[4] || 12);
const outPath = process.argv[5];

const DATE_FROM = process.env.DATE_FROM || '2024-06-01';
const DATE_TO = process.env.DATE_TO || '2026-07-04';
const startMs = Date.parse(DATE_FROM);
const endMs = Date.parse(`${DATE_TO}T23:59:59Z`);
const INITIAL = Number(process.env.INITIAL || 10000);

const toWick = (rows) => rows.map((r) => ({
  timeMs: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] || 0),
}));

const markets = [];
for (const sym of symbols) {
  const raw = hybrid.readHybridCandles(sym, '15m', { startMs, endMs, limit: 0 });
  if (!raw || raw.length < 200) continue;
  markets.push({ key: sym, candles: toWick(raw) });
}

const res = ms.runMomentumScalpPortfolio(markets, {
  ...ms.tvTrendScalpPreset(),
  ...ms.tvBurstEp4Preset(),
  barMinutes: 15,
  initialBalance: INITIAL,
  positionFraction: lot / 100,
  maxOpenPositions: op,
});

const ep4 = ms.summarizeWindow(res.trades, Date.parse('2026-05-01'), Date.parse('2026-06-30T23:59:59Z'), INITIAL);
const ep3 = ms.summarizeWindow(res.trades, Date.parse('2025-07-24'), Date.parse('2025-10-11T23:59:59Z'), INITIAL);

const out = {
  symbols: markets.map((m) => m.key),
  legs: markets.length,
  lotPercent: lot,
  maxOpenPositions: op,
  ret: res.summary.totalReturnPercent,
  dd: res.summary.maxDrawdownPercent,
  trades: res.summary.tradesCount,
  pf: res.summary.profitFactor,
  finalEquity: res.summary.finalEquity,
  ep3,
  ep4,
  perMarket: res.perMarket.sort((a, b) => b.netPnl - a.netPnl),
};

if (outPath) fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
else console.log(JSON.stringify(out));

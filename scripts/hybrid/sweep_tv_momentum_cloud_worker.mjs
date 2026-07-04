#!/usr/bin/env node
/**
 * Worker: isolated TV momentum scalp per symbol (hybrid 15m candles).
 *   node sweep_tv_momentum_cloud_worker.mjs <symbols.json> <out.json>
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

const symbolsPath = process.argv[2];
const outPath = process.argv[3];
if (!symbolsPath || !outPath) {
  console.error('Usage: sweep_tv_momentum_cloud_worker.mjs <symbols.json> <out.json>');
  process.exit(2);
}

const symbols = JSON.parse(fs.readFileSync(symbolsPath, 'utf-8'));
const DATE_FROM = process.env.DATE_FROM || '2024-06-01';
const DATE_TO = process.env.DATE_TO || '2026-07-04';
const startMs = Date.parse(DATE_FROM);
const endMs = Date.parse(`${DATE_TO}T23:59:59Z`);

const WINDOWS = {
  ep4: { from: Date.parse('2026-05-01'), to: Date.parse('2026-06-30T23:59:59Z') },
  ep3: { from: Date.parse('2025-07-24'), to: Date.parse('2025-10-11T23:59:59Z') },
};

const toWick = (rows) => rows.map((r) => ({
  timeMs: Number(r[0]),
  open: Number(r[1]),
  high: Number(r[2]),
  low: Number(r[3]),
  close: Number(r[4]),
  volume: Number(r[5] || 0),
}));

const preset = {
  ...ms.tvTrendScalpPreset(),
  ...ms.tvBurstEp4Preset(),
  barMinutes: 15,
  initialBalance: 1000,
  positionFraction: 1,
};

const rows = [];
for (const sym of symbols) {
  const raw = hybrid.readHybridCandles(sym, '15m', { startMs, endMs, limit: 0 });
  if (!raw || raw.length < 200) {
    rows.push({ sym, skip: true, reason: 'no_candles', bars: raw?.length || 0 });
    continue;
  }
  const candles = toWick(raw);
  const res = ms.runMomentumScalpBacktest(candles, preset);
  const ep4 = ms.summarizeWindow(res.trades, WINDOWS.ep4.from, WINDOWS.ep4.to, preset.initialBalance);
  const ep3 = ms.summarizeWindow(res.trades, WINDOWS.ep3.from, WINDOWS.ep3.to, preset.initialBalance);
  rows.push({
    sym,
    skip: false,
    bars: candles.length,
    ep3,
    ep4,
    full: {
      ret: res.summary.totalReturnPercent,
      dd: res.summary.maxDrawdownPercent,
      trades: res.summary.tradesCount,
      pf: res.summary.profitFactor,
      winRate: res.summary.winRatePercent,
    },
    preset: { emaFast: 8, emaSlow: 21, adxMin: 20, tp: 2, sl: 1.2, side: 'both' },
  });
  process.stderr.write(`[w${process.env.HYBRID_WORKER_ID || '?'}] ${sym} tr=${res.summary.tradesCount} ep4=${ep4.ret.toFixed(1)}%\n`);
}

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify({ worker: process.env.HYBRID_WORKER_ID || '', rows }, null, 2));

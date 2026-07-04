#!/usr/bin/env node
/**
 * TV EMA+ADX burst cloud — honest sizing + JSON for v4.1 overlay.
 *   cd backend && npm run build && node ../scripts/ep4_tv_burst_overlay.mjs
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
const DATE_FROM = process.env.DATE_FROM || '2024-06-01';
const DATE_TO = process.env.DATE_TO || '2026-07-03';

const BURST_INITIAL = Number(process.env.BURST_INITIAL || '2000');
const BURST_OP = Number(process.env.BURST_OP || '3');
const POSITION_FRAC = Number(process.env.BURST_POSITION_FRAC || '0.75');

const WINDOWS = {
  ep4: { from: '2026-05-01', to: '2026-06-30' },
  ep3: { from: '2025-07-24', to: '2025-10-11' },
};

fs.mkdirSync(OUT, { recursive: true });
await ensureExchangeClientInitialized(API_KEY);

const preset = ms.tvBurstEp4Preset();
const symbols = ms.TV_BURST_MONO_MARKETS;

const markets = [];
for (const sym of symbols) {
  const candles = await wickData.fetchMonoCandles(API_KEY, sym, '15m', {
    startMs: Date.parse(DATE_FROM),
    endMs: Date.parse(`${DATE_TO}T23:59:59Z`),
    limit: 8000,
  });
  console.log(`${sym} 15m: ${candles.length} bars`);
  markets.push({ key: sym, candles, config: preset });
}

const portfolio = ms.runMomentumScalpPortfolio(markets, {
  ...preset,
  initialBalance: BURST_INITIAL,
  positionFraction: POSITION_FRAC,
  maxOpenPositions: BURST_OP,
  commissionPercent: 0.1,
  slippagePercent: 0.05,
});

const winSlice = (label, from, to) => {
  const t0 = Date.parse(from);
  const t1 = Date.parse(`${to}T23:59:59Z`);
  const w = ms.summarizeWindow(portfolio.trades, t0, t1, BURST_INITIAL);
  return { label, ...w };
};

const out = {
  generatedAt: new Date().toISOString(),
  preset: { ...preset, initialBalance: BURST_INITIAL, positionFraction: POSITION_FRAC, maxOpenPositions: BURST_OP },
  markets: symbols,
  summary: portfolio.summary,
  perMarket: portfolio.perMarket,
  windows: {
    ep4: winSlice('EP4', WINDOWS.ep4.from, WINDOWS.ep4.to),
    ep3: winSlice('EP3', WINDOWS.ep3.from, WINDOWS.ep3.to),
  },
  equityCurve: portfolio.equityCurve,
  trades: portfolio.trades.slice(0, 500),
  tradesTotal: portfolio.trades.length,
};

const fp = path.join(OUT, 'tv_burst_honest_overlay.json');
fs.writeFileSync(fp, JSON.stringify(out, null, 2));
console.log(`\nBurst honest: ret=${portfolio.summary.totalReturnPercent.toFixed(2)}% dd=${portfolio.summary.maxDrawdownPercent.toFixed(2)}% tr=${portfolio.summary.tradesCount} pf=${portfolio.summary.profitFactor.toFixed(2)}`);
console.log(`EP4: ret=${out.windows.ep4.ret.toFixed(2)}% tr=${out.windows.ep4.trades} pnl=${out.windows.ep4.netPnl.toFixed(1)}`);
console.log(`EP3: ret=${out.windows.ep3.ret.toFixed(2)}% tr=${out.windows.ep3.trades} pnl=${out.windows.ep3.netPnl.toFixed(1)}`);
console.log(`wrote ${fp}`);

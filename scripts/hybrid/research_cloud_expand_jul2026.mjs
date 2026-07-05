#!/usr/bin/env node
/**
 * Expanded TV cloud research: all bundle symbols + indicator preset grid on top candidates.
 *   HYBRID_CANDLE_DIR=results/hybrid_candle_bundle_15m node scripts/hybrid/research_cloud_expand_jul2026.mjs
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

const OUT_DIR = path.join(root, 'results', 'tv_momentum_cloud');
const OUT = path.join(OUT_DIR, 'cloud_expand_research_jul2026.json');
const DATE_FROM = process.env.DATE_FROM || '2024-06-01';
const DATE_TO = process.env.DATE_TO || '2026-07-04';
const startMs = Date.parse(DATE_FROM);
const endMs = Date.parse(`${DATE_TO}T23:59:59Z`);
const WINDOWS = {
  ep4: { from: Date.parse('2026-05-01'), to: Date.parse('2026-06-30T23:59:59Z') },
  ep3: { from: Date.parse('2025-07-24'), to: Date.parse('2025-10-11T23:59:59Z') },
};

const toWick = (rows) => rows.map((r) => ({
  timeMs: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]), volume: Number(r[5] || 0),
}));

const basePreset = () => ({
  ...ms.tvTrendScalpPreset(),
  ...ms.tvBurstEp4Preset(),
  barMinutes: 15,
  initialBalance: 1000,
  positionFraction: 1,
});

function runSym(sym, preset) {
  const raw = hybrid.readHybridCandles(sym, '15m', { startMs, endMs, limit: 0 });
  if (!raw || raw.length < 200) return null;
  const candles = toWick(raw);
  const res = ms.runMomentumScalpBacktest(candles, preset);
  const ep4 = ms.summarizeWindow(res.trades, WINDOWS.ep4.from, WINDOWS.ep4.to, preset.initialBalance);
  const ep3 = ms.summarizeWindow(res.trades, WINDOWS.ep3.from, WINDOWS.ep3.to, preset.initialBalance);
  return {
    sym,
    bars: candles.length,
    ep3, ep4,
    full: {
      ret: res.summary.totalReturnPercent,
      dd: res.summary.maxDrawdownPercent,
      trades: res.summary.tradesCount,
      pf: res.summary.profitFactor,
    },
    preset,
  };
}

function score(r) {
  return (r.ep4.ret || 0) * 1.2 + (r.ep3.ret || 0) + (r.full.ret || 0) * 0.25 - (r.full.dd || 0) * 0.6;
}

const symbols = hybrid.listHybridCandleSymbols('15m').sort();
console.log(`[expand] symbols=${symbols.length}`);

const baselineRows = [];
for (const sym of symbols) {
  const row = runSym(sym, basePreset());
  if (row) baselineRows.push(row);
  process.stderr.write(`[base] ${sym} ${row ? `${row.full.ret.toFixed(0)}%/${row.full.dd.toFixed(1)}%` : 'skip'}\n`);
}
baselineRows.sort((a, b) => score(b) - score(a));

const IND_GRID = [];
for (const emaFast of [6, 8, 10]) {
  for (const adxMin of [18, 20, 22]) {
    for (const tp of [1.8, 2.0, 2.5]) {
      for (const sl of [1.0, 1.2, 1.5]) {
        IND_GRID.push({ emaFastPeriod: emaFast, emaSlowPeriod: 21, adxMin, tpPercent: tp, slPercent: sl, label: `e${emaFast}_a${adxMin}_tp${tp}_sl${sl}` });
      }
    }
  }
}

const topSyms = baselineRows.slice(0, 25).map((r) => r.sym);
const indicatorRows = [];
for (const spec of IND_GRID) {
  let sum = 0;
  let n = 0;
  const perSym = [];
  for (const sym of topSyms) {
    const p = { ...basePreset(), emaFastPeriod: spec.emaFastPeriod, emaSlowPeriod: spec.emaSlowPeriod, adxMin: spec.adxMin, tpPercent: spec.tpPercent, slPercent: spec.slPercent };
    const row = runSym(sym, p);
    if (!row) continue;
    perSym.push({ sym, ret: row.full.ret, dd: row.full.dd, ep4: row.ep4.ret });
    sum += score(row);
    n += 1;
  }
  if (n > 0) {
    indicatorRows.push({ ...spec, avgScore: sum / n, tested: n, perSymSample: perSym.slice(0, 5) });
  }
  process.stderr.write(`[ind] ${spec.label} avg=${n ? (sum / n).toFixed(1) : 'na'}\n`);
}
indicatorRows.sort((a, b) => b.avgScore - a.avgScore);

const report = {
  generatedAt: new Date().toISOString(),
  symbolCount: symbols.length,
  baselineTop30: baselineRows.slice(0, 30),
  baselineAll: baselineRows,
  indicatorGridTop15: indicatorRows.slice(0, 15),
  currentPick20: JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'tv_cloud_spread_rank_jul2026.json'), 'utf-8')).pickedSymbols || [],
  suggestedPick20: baselineRows.slice(0, 20).map((r) => r.sym),
  bestIndicator: indicatorRows[0] || null,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(report, null, 2));
console.log(`wrote ${OUT}`);
console.log(`best indicator: ${indicatorRows[0]?.label || 'n/a'}`);
console.log(`suggested 20: ${report.suggestedPick20.join(', ')}`);

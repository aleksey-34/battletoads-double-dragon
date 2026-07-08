#!/usr/bin/env node
/**
 * Replay momentum_scalp_tv raw signals on WEEX candles for last N hours.
 * Compares raw flips vs live exchange_fill entries on one reference client.
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
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const { getMarketData } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const {
  buildMomentumScalpIndicatorSeries,
  extractMomentumScalpParams,
  computeMomentumScalpSignalAtIndex,
} = require(path.join(backendRoot, 'dist/bot/momentumScalpSignal.js'));

const API_KEY = process.env.API_KEY || 'artursk-6323499563-api';
const HOURS = Number(process.env.HOURS || 48);
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'momentum_signal_replay_48h.json');
const TO_MS = Date.now();
const FROM_MS = TO_MS - HOURS * 3600_000;

const normMs = (t) => {
  const v = Number(t || 0);
  return v > 0 && v < 1e12 ? v * 1000 : v;
};

await database.initDB();
const { db } = database;
await ensureExchangeClientInitialized(API_KEY);

const legs = await db.all(
  `SELECT s.id, s.name, s.base_symbol, s.interval, s.*
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   WHERE a.name = ?
     AND s.strategy_type = 'momentum_scalp_tv'
     AND s.is_active = 1 AND s.auto_update = 1
   ORDER BY s.base_symbol`,
  [API_KEY],
);

// Prefer high-priority symbols from the cards, then fill up to TOP_N.
const TOP_N = Number(process.env.TOP_N || 10);
const PRIORITY = (process.env.SYMBOLS || 'NEARUSDT,SUIUSDT,SOLUSDT,WIFUSDT,ENAUSDT,EIGENUSDT,DOGEUSDT,ARBUSDT,APTUSDT,TIAUSDT')
  .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
const bySym = new Map();
for (const row of legs) {
  const sym = String(row.base_symbol || '').toUpperCase();
  if (!bySym.has(sym)) bySym.set(sym, row);
}
const selected = [];
for (const sym of PRIORITY) {
  if (bySym.has(sym) && selected.length < TOP_N) selected.push(bySym.get(sym));
}
for (const row of bySym.values()) {
  if (selected.length >= TOP_N) break;
  if (!selected.includes(row)) selected.push(row);
}

const report = {
  generatedAt: new Date().toISOString(),
  apiKey: API_KEY,
  windowHours: HOURS,
  from: new Date(FROM_MS).toISOString(),
  to: new Date(TO_MS).toISOString(),
  legs: [],
  totals: { rawFlips: 0, liveEntries: 0, symbolsWithFlips: 0, symbolsLive: 0 },
};

console.log(`Momentum replay ${HOURS}h | ${selected.length} symbols | ${API_KEY}`);

for (const strategy of selected) {
  const sym = String(strategy.base_symbol || '').toUpperCase();
  const interval = String(strategy.interval || '15m');
  const params = extractMomentumScalpParams(strategy);

  let candles = [];
  try {
    const raw = await getMarketData(API_KEY, sym, interval, 800, {
      startMs: FROM_MS - 2 * 24 * 3600_000,
      endMs: TO_MS,
    });
    candles = (Array.isArray(raw) ? raw : []).map((c) => ({
      open: Number(c.open ?? c.o),
      high: Number(c.high ?? c.h),
      low: Number(c.low ?? c.l),
      close: Number(c.close ?? c.c),
      timeMs: normMs(c.timeMs ?? c.time ?? c.t),
    })).filter((c) => c.timeMs > 0 && Number.isFinite(c.close));
  } catch (err) {
    report.legs.push({ symbol: sym, strategyId: strategy.id, error: err.message });
    console.log(`ERR ${sym}: ${err.message}`);
    continue;
  }

  const series = buildMomentumScalpIndicatorSeries(candles, params);
  let flips = 0;
  let longSig = 0;
  let shortSig = 0;
  let state = 'flat';
  const flipTimes = [];
  for (let i = series.warmup; i < candles.length; i += 1) {
    const t = candles[i].timeMs;
    if (t < FROM_MS || t >= TO_MS) continue;
    const ms = computeMomentumScalpSignalAtIndex(candles, i, params, series, state);
    if (ms.signal === 'long' && state === 'flat') {
      flips += 1; longSig += 1; state = 'long';
      flipTimes.push({ side: 'long', time: new Date(t).toISOString() });
    } else if (ms.signal === 'short' && state === 'flat') {
      flips += 1; shortSig += 1; state = 'short';
      flipTimes.push({ side: 'short', time: new Date(t).toISOString() });
    } else if (state !== 'flat' && (ms.oppositeCross || ms.signal === 'none')) {
      state = 'flat';
    }
  }

  const liveRow = await db.get(
    `SELECT COUNT(*) AS n FROM live_trade_events
     WHERE strategy_id = ?
       AND trade_type = 'entry'
       AND COALESCE(event_origin,'exchange_fill') = 'exchange_fill'
       AND actual_time >= ? AND actual_time < ?`,
    [strategy.id, FROM_MS, TO_MS],
  );
  const liveEntries = Number(liveRow?.n || 0);

  const row = {
    symbol: sym,
    strategyId: strategy.id,
    interval,
    bars: candles.length,
    rawFlips: flips,
    longSig,
    shortSig,
    liveEntries,
    gap: flips - liveEntries,
    sampleFlips: flipTimes.slice(0, 6),
  };
  report.legs.push(row);
  report.totals.rawFlips += flips;
  report.totals.liveEntries += liveEntries;
  if (flips > 0) report.totals.symbolsWithFlips += 1;
  if (liveEntries > 0) report.totals.symbolsLive += 1;
  console.log(`${sym}: raw=${flips} live=${liveEntries} gap=${flips - liveEntries}`);
}

report.verdict =
  report.totals.rawFlips === 0 && report.totals.liveEntries === 0
    ? 'regime_no_signal_both_zero'
    : report.totals.rawFlips > 0 && report.totals.liveEntries === 0
      ? 'BUG_raw_signals_but_no_live'
      : report.totals.rawFlips === report.totals.liveEntries
        ? 'parity_ok'
        : 'partial_gap_investigate';

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(`VERDICT: ${report.verdict}`);
console.log(`Wrote ${OUT_JSON}`);

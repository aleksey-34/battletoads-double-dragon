#!/usr/bin/env node
/**
 * Compare live strategy_signal trades vs backtest on the same window.
 * Types: CT_Fractal, zz_breakout, momentum_scalp_tv
 *
 *   DB_FILE=/opt/.../database.db node scripts/hybrid/compare_live_vs_backtest_signals_jul2026.mjs
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
const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine.js'));
const { ensureExchangeClientInitialized } = require(path.join(backendRoot, 'dist/bot/exchange.js'));
const { loadStrategyCandles } = require(path.join(backendRoot, 'dist/bot/strategy/candles.js'));
const { computeCtFractalSignalAtIndex } = require(path.join(backendRoot, 'dist/bot/ctFractalSignal.js'));
const {
  buildMomentumScalpIndicatorSeries,
  extractMomentumScalpParams,
  computeMomentumScalpSignalAtIndex,
} = require(path.join(backendRoot, 'dist/bot/momentumScalpSignal.js'));
const wickData = require(path.join(backendRoot, 'dist/research/wickRetestData.js'));

const DB_FILE = process.env.DB_FILE || process.env.BTDD_DB_PATH || path.join(backendRoot, 'database.db');
const DATE_FROM = process.env.DATE_FROM || '2026-07-04';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const BT_DATE_FROM = process.env.BT_DATE_FROM || '2026-05-01';
const API_KEY = process.env.API_KEY || 'artursk-6323499563-api';
// Candle source for BT/raw signals. WEEX copy keys often lack history — default to BTDD_D1 (BingX).
const DATA_API_KEY = process.env.DATA_API_KEY
  || ( /^Copy_/i.test(API_KEY) || /weex/i.test(API_KEY) ? 'BTDD_D1' : API_KEY );
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'live_vs_backtest_signals_jul2026.json');
const LIVE_EVENT_ORIGIN = process.env.LIVE_EVENT_ORIGIN || 'exchange_fill';

const FROM_MS = Date.parse(`${DATE_FROM}T00:00:00Z`);
const TO_MS = Date.parse(`${DATE_TO}T23:59:59Z`) + 1;
const BAR_TOL_MS = Number(process.env.BAR_TOL_MS || 0) || 90_000;

const normMs = (t) => {
  const v = Number(t || 0);
  return v > 0 && v < 1_000_000_000_000 ? v * 1000 : v;
};

const msToIso = (ms) => new Date(normMs(ms)).toISOString().replace('T', ' ').slice(0, 19);

const intervalMs = (interval) => {
  const m = String(interval || '15m').match(/^(\d+)([mhd])$/i);
  if (!m) return 15 * 60_000;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'h') return n * 3600_000;
  if (u === 'd') return n * 86400_000;
  return n * 60_000;
};

const countLiveSynthCycles = (entries, strategy) => {
  if (String(strategy.market_mode || '') !== 'synthetic') {
    return entries.length;
  }
  const base = String(strategy.base_symbol || '').toUpperCase();
  const baseOnly = entries.filter((e) => String(e.symbol || '').toUpperCase().startsWith(base.slice(0, 4)));
  const barMs = intervalMs(strategy.interval);
  const buckets = new Set();
  for (const e of baseOnly.length ? baseOnly : entries) {
    buckets.add(`${Math.floor(normMs(e.timeMs) / barMs)}|${e.side}`);
  }
  return buckets.size || Math.ceil(entries.length / 2);
};

const matchEntries = (liveEntries, btEntries, barMs = 15 * 60_000) => {
  const used = new Set();
  const matched = [];
  const liveOnly = [];
  for (const le of liveEntries) {
    const t = normMs(le.barTimeMs ?? le.timeMs);
    let best = -1;
    let bestD = Infinity;
    for (let i = 0; i < btEntries.length; i += 1) {
      if (used.has(i)) continue;
      const be = btEntries[i];
      if (be.side !== le.side) continue;
      const btBar = Math.floor(normMs(be.timeMs) / barMs) * barMs;
      const d = Math.abs(btBar - t);
      if (d < bestD) { bestD = d; best = i; }
    }
    if (best >= 0 && bestD <= barMs + BAR_TOL_MS) {
      used.add(best);
      matched.push({ live: le, bt: btEntries[best], deltaMs: bestD });
    } else {
      liveOnly.push(le);
    }
  }
  const btOnly = btEntries.filter((_, i) => !used.has(i));
  return { matched, liveOnly, btOnly };
};

const donchianSignalAtIndex = (candles, index, length, source, longEnabled, shortEnabled) => {
  if (index < length) return 'none';
  const window = candles.slice(index - length, index);
  const levelLong = Math.max(...window.map((c) => c.high));
  const levelShort = Math.min(...window.map((c) => c.low));
  const bar = candles[index];
  const useClose = String(source || 'wick').toLowerCase() === 'close';
  const priceLong = useClose ? bar.close : bar.high;
  const priceShort = useClose ? bar.close : bar.low;
  if (longEnabled && priceLong > levelLong) return 'long';
  if (shortEnabled && priceShort < levelShort) return 'short';
  return 'none';
};

const countRawSignals = (strategy, candles) => {
  const type = String(strategy.strategy_type || '');
  const length = Math.max(2, Math.floor(Number(strategy.price_channel_length || 50)));
  const zEntry = Number(strategy.zscore_entry || 2);
  const longEn = Number(strategy.long_enabled ?? 1) !== 0;
  const shortEn = Number(strategy.short_enabled ?? 1) !== 0;
  let flips = 0;
  let longSig = 0;
  let shortSig = 0;
  let state = 'flat';

  if (type === 'momentum_scalp_tv') {
    const params = extractMomentumScalpParams(strategy);
    const series = buildMomentumScalpIndicatorSeries(candles, params);
    for (let i = series.warmup; i < candles.length; i += 1) {
      const ms = computeMomentumScalpSignalAtIndex(candles, i, params, series, state);
      if (ms.signal === 'long' && state === 'flat') { flips += 1; longSig += 1; state = 'long'; }
      else if (ms.signal === 'short' && state === 'flat') { flips += 1; shortSig += 1; state = 'short'; }
      else if (state !== 'flat' && (ms.oppositeCross || ms.signal === 'none')) state = 'flat';
    }
    return { flips, longSig, shortSig };
  }

  if (type === 'CT_Fractal') {
    for (let i = length + 120; i < candles.length; i += 1) {
      const ct = computeCtFractalSignalAtIndex(candles, i, length, zEntry, longEn, shortEn);
      if (ct.signal === 'long' && state === 'flat') { flips += 1; longSig += 1; state = 'long'; }
      else if (ct.signal === 'short' && state === 'flat') { flips += 1; shortSig += 1; state = 'short'; }
      else if (state !== 'flat') {
        const z = Number(ct.zScore);
        const rsi = Number(ct.fastRsi);
        if (state === 'long' && (z >= -zEntry * 0.25 || rsi > 90)) state = 'flat';
        if (state === 'short' && (z <= zEntry * 0.25 || rsi < 10)) state = 'flat';
      }
    }
    return { flips, longSig, shortSig };
  }

  if (type === 'zz_breakout') {
    for (let i = length; i < candles.length; i += 1) {
      const sig = donchianSignalAtIndex(candles, i, length, strategy.detection_source, longEn, shortEn);
      if (sig === 'long' && state === 'flat') { flips += 1; longSig += 1; state = 'long'; }
      else if (sig === 'short' && state === 'flat') { flips += 1; shortSig += 1; state = 'short'; }
      else if (state !== 'flat') state = 'flat';
    }
    return { flips, longSig, shortSig };
  }

  return { flips: 0, longSig: 0, shortSig: 0 };
};

const analyzeLiveChurn = (pairs, ivMs) => {
  let churn = 0;
  for (const p of pairs) {
    const hold = normMs(p.exitTime) - normMs(p.entryTime);
    if (hold >= 0 && hold < ivMs * 1.5) churn += 1;
  }
  return churn;
};

const fetchLiveEntries = async (db, strategyId) => {
  const originClause = LIVE_EVENT_ORIGIN === 'any'
    ? '1=1'
    : `COALESCE(event_origin, 'unknown') = ?`;
  const originArgs = LIVE_EVENT_ORIGIN === 'any' ? [] : [LIVE_EVENT_ORIGIN];
  const rows = await db.all(
    `SELECT trade_type, side, entry_time, actual_time, source_symbol
     FROM live_trade_events
     WHERE strategy_id = ?
       AND ${originClause}
       AND trade_type = 'entry'
       AND entry_time >= ? AND entry_time < ?
     ORDER BY entry_time ASC, id ASC`,
    [strategyId, ...originArgs, FROM_MS, TO_MS],
  );
  return (rows || []).map((r) => ({
    side: String(r.side || '').toLowerCase(),
    timeMs: normMs(r.actual_time || r.entry_time),
    barTimeMs: normMs(r.entry_time),
    symbol: r.source_symbol,
  }));
};

const fetchLiveRoundTrips = async (db, strategyId) => {
  const originClause = LIVE_EVENT_ORIGIN === 'any'
    ? '1=1'
    : `COALESCE(event_origin, 'unknown') = ?`;
  const originArgs = LIVE_EVENT_ORIGIN === 'any' ? [] : [LIVE_EVENT_ORIGIN];
  const rows = await db.all(
    `SELECT trade_type, side, entry_time, actual_time, entry_price, actual_price, position_size
     FROM live_trade_events
     WHERE strategy_id = ?
       AND ${originClause}
       AND actual_time >= ? AND actual_time < ?
     ORDER BY actual_time ASC, id ASC`,
    [strategyId, ...originArgs, FROM_MS, TO_MS],
  );
  const open = new Map();
  const trips = [];
  for (const r of rows || []) {
    const side = String(r.side || '').toLowerCase();
    const key = side;
    const tt = String(r.trade_type || '').toLowerCase();
    if (tt === 'entry') {
      open.set(key, { entryTime: normMs(r.entry_time || r.actual_time), side });
    } else if (tt === 'exit' && open.has(key)) {
      const ent = open.get(key);
      trips.push({ entryTime: ent.entryTime, exitTime: normMs(r.actual_time), side });
      open.delete(key);
    }
  }
  return trips;
};

const countFleetMultiplier = async (db, sourceSid, strategyType) => {
  const originClause = LIVE_EVENT_ORIGIN === 'any'
    ? '1=1'
    : `COALESCE(lte.event_origin, 'unknown') = ?`;
  const originArgs = LIVE_EVENT_ORIGIN === 'any' ? [] : [LIVE_EVENT_ORIGIN];
  const row = await db.get(
    `SELECT COUNT(DISTINCT a.name) AS clients,
            COUNT(*) AS live_entries
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name
     WHERE ap.actual_enabled = 1
       AND s.strategy_type = ?
       AND s.name LIKE ?
       AND ${originClause}
       AND lte.trade_type = 'entry'
       AND lte.entry_time >= ? AND lte.entry_time < ?`,
    [strategyType, `%::SID${sourceSid}`, ...originArgs, FROM_MS, TO_MS],
  );
  return {
    clients: Number(row?.clients || 0),
    liveEntriesFleet: Number(row?.live_entries || 0),
  };
};

const pickStrategies = async (db) => {
  const specs = [
    {
      label: 'momentum_scalp_tv',
      type: 'momentum_scalp_tv',
      query: `SELECT s.id, s.name, a.name AS api_key
              FROM strategies s
              JOIN api_keys a ON a.id=s.api_key_id
              JOIN live_trade_events lte ON lte.strategy_id=s.id
              WHERE a.name=? AND s.strategy_type='momentum_scalp_tv'
                AND lte.trade_type='entry' AND lte.entry_time >= ? AND lte.entry_time < ?
              GROUP BY s.id ORDER BY COUNT(*) DESC LIMIT 1`,
      args: [API_KEY, FROM_MS, TO_MS],
    },
    {
      label: 'CT_Fractal_FIL_mono',
      type: 'CT_Fractal',
      query: `SELECT s.id, s.name, a.name AS api_key
              FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
              WHERE a.name=? AND s.strategy_type='CT_Fractal' AND s.name LIKE '%FILUSDT::SID239259%'
              LIMIT 1`,
      args: [API_KEY],
    },
    {
      label: 'CT_Fractal_PENDLE_synth',
      type: 'CT_Fractal',
      query: `SELECT s.id, s.name, a.name AS api_key
              FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
              WHERE a.name=? AND s.strategy_type='CT_Fractal' AND s.name LIKE '%PENDLEUSDT/EIGENUSDT::SID242969%'
              LIMIT 1`,
      args: [API_KEY],
    },
    {
      label: 'CT_Fractal_HBAR_active',
      type: 'CT_Fractal',
      query: `SELECT s.id, s.name, a.name AS api_key
              FROM strategies s JOIN api_keys a ON a.id=s.api_key_id
              WHERE a.name=? AND s.strategy_type='CT_Fractal' AND s.is_active=1 AND s.name LIKE '%HBARUSDT%'
              LIMIT 1`,
      args: [API_KEY],
    },
    {
      label: 'zz_breakout_hist',
      type: 'zz_breakout',
      query: `SELECT s.id, s.name, a.name AS api_key
              FROM strategies s
              JOIN api_keys a ON a.id = s.api_key_id
              JOIN live_trade_events lte ON lte.strategy_id=s.id
              WHERE s.strategy_type='zz_breakout' AND a.name=?
                AND s.base_symbol='ORDIUSDT'
                AND lte.entry_time >= ? AND lte.entry_time < ?
              LIMIT 1`,
      args: [API_KEY, Date.parse('2026-06-28T00:00:00Z'), TO_MS],
    },
  ];
  const out = [];
  for (const spec of specs) {
    const row = await db.get(spec.query, spec.args);
    if (row) out.push({ ...spec, ...row });
  }
  return out;
};

const analyzeStrategy = async (db, spec) => {
  const strategy = await db.get('SELECT * FROM strategies WHERE id=?', [spec.id]);
  if (!strategy) return null;
  const apiKey = spec.api_key || API_KEY;
  await ensureExchangeClientInitialized(apiKey);
  if (DATA_API_KEY && DATA_API_KEY !== apiKey) {
    await ensureExchangeClientInitialized(DATA_API_KEY);
  }

  const liveEntriesRaw = await fetchLiveEntries(db, spec.id);
  const liveEntries = String(strategy.market_mode || '') === 'synthetic'
    ? liveEntriesRaw.filter((e) => String(e.symbol || '').toUpperCase().startsWith(String(strategy.base_symbol || '').toUpperCase().slice(0, 4)))
    : liveEntriesRaw;
  const liveTrips = await fetchLiveRoundTrips(db, spec.id);
  const sidMatch = String(strategy.name || '').match(/::SID(\d+)$/);
  const sourceSid = sidMatch ? sidMatch[1] : '';
  const fleet = sourceSid
    ? await countFleetMultiplier(db, sourceSid, spec.type)
    : { clients: 1, liveEntriesFleet: liveEntries.length };

  const bt = await runBacktest({
    apiKeyName: apiKey,
    dataApiKeyName: DATA_API_KEY,
    mode: 'single',
    strategyId: spec.id,
    dateFrom: BT_DATE_FROM,
    dateTo: DATE_TO,
    bars: 2500,
    warmupBars: 0,
    skipMissingSymbols: true,
    initialBalance: 10000,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    lotPercentOverride: Number(strategy.lot_long_percent || 50),
    reinvestPercentOverride: 0,
    enablePairLock: false,
  });

  const btEntriesAll = (bt.trades || []).map((t) => ({
    side: String(t.side || '').toLowerCase(),
    timeMs: normMs(t.entryTime),
    exitTimeMs: normMs(t.exitTime),
    netPnl: Number(t.netPnl || 0),
  }));
  const btEntries = btEntriesAll.filter((t) => t.timeMs >= FROM_MS && t.timeMs < TO_MS);

  const iv = intervalMs(strategy.interval);
  const { matched, liveOnly, btOnly } = matchEntries(liveEntries, btEntries, iv);

  let candles = [];
  try {
    const loaded = await loadStrategyCandles(strategy, DATA_API_KEY, { minBars: 300 });
    candles = (loaded?.candles || []).filter((c) => c.timeMs >= FROM_MS - 7 * 86400_000 && c.timeMs < TO_MS);
  } catch (err) {
    const base = String(strategy.base_symbol || '').toUpperCase();
    const quote = String(strategy.quote_symbol || '').toUpperCase();
    const mode = String(strategy.market_mode || '').toLowerCase();
    // For mono: one symbol. For synth: skip wick mono fallback (needs ratio series).
    const sym = mode === 'synthetic' ? '' : base;
    if (sym) {
      const raw = await wickData.fetchMonoCandles(DATA_API_KEY, sym, strategy.interval || '15m', {
        startMs: FROM_MS - 7 * 86400_000,
        endMs: TO_MS,
        limit: 8000,
      });
      candles = raw.map((c) => ({ open: c.open, high: c.high, low: c.low, close: c.close, timeMs: c.timeMs }));
    } else {
      console.warn(`candle load failed for ${spec.id} (${base}/${quote}): ${err.message}`);
    }
  }

  const windowCandles = candles.filter((c) => c.timeMs >= FROM_MS && c.timeMs < TO_MS);
  const warmupCandles = candles.filter((c) => c.timeMs < FROM_MS);
  const rawSignalsWindow = countRawSignals(strategy, windowCandles.length ? [...warmupCandles.slice(-300), ...windowCandles] : candles);
  const rawSignals = rawSignalsWindow;
  const days = Math.max(0.25, (TO_MS - FROM_MS) / 86400_000);

  const dupLiveBars = new Map();
  for (const e of liveEntries) {
    const k = `${e.side}|${e.timeMs}`;
    dupLiveBars.set(k, (dupLiveBars.get(k) || 0) + 1);
  }
  const duplicateBarEntries = [...dupLiveBars.values()].filter((n) => n > 1).length;

  const btTrips = btEntriesAll
    .filter((t) => t.timeMs >= FROM_MS && t.timeMs < TO_MS)
    .map((t) => ({
      entryTime: t.timeMs,
      exitTime: t.exitTimeMs,
      side: t.side,
    }));

  const livePnlRows = await db.all(
    `SELECT trade_type, side, entry_price, actual_price, position_size, actual_fee
     FROM live_trade_events
     WHERE strategy_id = ? AND COALESCE(event_origin,'unknown') = ?
       AND actual_time >= ? AND actual_time < ?
     ORDER BY actual_time ASC`,
    [spec.id, LIVE_EVENT_ORIGIN === 'any' ? 'exchange_fill' : LIVE_EVENT_ORIGIN, FROM_MS, TO_MS],
  );
  let livePnl = 0;
  const openLive = new Map();
  for (const r of livePnlRows || []) {
    const side = String(r.side || '').toLowerCase();
    const tt = String(r.trade_type || '').toLowerCase();
    if (tt === 'entry') {
      openLive.set(side, r);
    } else if (tt === 'exit' && openLive.has(side)) {
      const ent = openLive.get(side);
      const qty = Number(ent.position_size || 0);
      const ep = Number(ent.entry_price || 0);
      const xp = Number(r.actual_price || 0);
      const fee = Number(ent.actual_fee || 0) + Number(r.actual_fee || 0);
      const gross = side === 'long' ? (xp - ep) * qty : (ep - xp) * qty;
      livePnl += gross - fee;
      openLive.delete(side);
    }
  }

  return {
    label: spec.label,
    type: spec.type,
    strategyId: spec.id,
    name: strategy.name,
    apiKey,
    sourceSid,
    interval: strategy.interval,
    window: { from: DATE_FROM, to: DATE_TO, btFrom: BT_DATE_FROM, days: Number(days.toFixed(2)) },
    fleet,
    counts: {
      liveEntriesRaw: liveEntriesRaw.length,
      liveSynthCycles: countLiveSynthCycles(liveEntriesRaw, strategy),
      liveEntries: liveEntries.length,
      btEntries: btEntries.length,
      btEntriesAll: btEntriesAll.length,
      matched: matched.length,
      liveOnly: liveOnly.length,
      btOnly: btOnly.length,
      liveRoundTrips: liveTrips.length,
      btRoundTrips: btTrips.length,
      rawSignalFlips: rawSignals.flips,
      barsInWindow: windowCandles.length,
      duplicateBarEntries,
      liveChurnFast: analyzeLiveChurn(liveTrips, iv),
      btChurnFast: analyzeLiveChurn(btTrips, iv),
    },
    ratesPerDay: {
      live: Number((liveEntries.length / days).toFixed(2)),
      liveSynth: Number((countLiveSynthCycles(liveEntriesRaw, strategy) / days).toFixed(2)),
      bt: Number((btEntries.length / days).toFixed(2)),
      rawSignals: Number((rawSignals.flips / days).toFixed(2)),
      fleetLive: Number((fleet.liveEntriesFleet / days).toFixed(2)),
    },
    livePnl: Number(livePnl.toFixed(2)),
    btPnl: Number(btEntries.reduce((s, t) => s + Number(t.netPnl || 0), 0).toFixed(2)),
    samples: {
      matched: matched.slice(0, 5).map((m) => ({
        side: m.live.side,
        live: msToIso(m.live.timeMs),
        bt: msToIso(m.bt.timeMs),
        deltaSec: Math.round(m.deltaMs / 1000),
      })),
      liveOnly: liveOnly.slice(0, 8).map((e) => ({ side: e.side, time: msToIso(e.timeMs) })),
      btOnly: btOnly.slice(0, 8).map((e) => ({ side: e.side, time: msToIso(e.timeMs) })),
    },
    btSummary: bt.summary || null,
    findings: [],
  };
};

const buildFindings = (r) => {
  const f = [];
  const c = r.counts;
  if (c.liveEntries > c.btEntries * 3 && c.btEntries > 0) {
    f.push(`Live entries ${c.liveEntries} vs BT ${c.btEntries} (${(c.liveEntries / Math.max(1, c.btEntries)).toFixed(1)}x) on ONE client`);
  }
  if (r.fleet.clients > 1 && r.fleet.liveEntriesFleet > c.liveEntries) {
    f.push(`Fleet multiplier: ${r.fleet.clients} clients → ${r.fleet.liveEntriesFleet} entries (${(r.fleet.liveEntriesFleet / Math.max(1, c.liveEntries)).toFixed(1)}x vs single)`);
  }
  if (c.rawSignalFlips > 0 && Math.abs(c.rawSignalFlips - c.btEntries) <= 2) {
    f.push('BT trades align with raw bar signals — engine parity OK');
  }
  if (c.rawSignalFlips > 0 && c.liveEntries > c.rawSignalFlips * 2) {
    f.push(`Live entries ${c.liveEntries} >> raw signal flips ${c.rawSignalFlips} — runtime churn / rescans / multi-client`);
  }
  if (c.liveChurnFast > c.liveRoundTrips * 0.3) {
    f.push(`Live fast churn: ${c.liveChurnFast}/${c.liveRoundTrips} round-trips < 1.5 bars`);
  }
  if (c.duplicateBarEntries > 0) {
    f.push(`Duplicate live entries same bar/side: ${c.duplicateBarEntries} cases`);
  }
  if (c.matched === 0 && c.liveEntries > 0 && c.btEntries > 0) {
    f.push('Zero time-aligned matches — check interval/candle source or date window');
  }
  if (c.liveOnly > 2) {
    f.push(`${c.liveOnly} live-only entries (BT did not fire at same bar)`);
  }
  if (c.btOnly > 2) {
    f.push(`${c.btOnly} BT-only entries (live missed — gates/offline/state)`);
  }
  r.findings = f;
};

await database.initDB();
const { db } = database;

const specs = await pickStrategies(db);
console.log(`Window ${DATE_FROM}..${DATE_TO} | API ${API_KEY} | candles ${DATA_API_KEY} | legs ${specs.length}`);

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: DATE_FROM, to: DATE_TO },
  apiKey: API_KEY,
  dataApiKey: DATA_API_KEY,
  legs: [],
  recommendations: [],
};

for (const spec of specs) {
  console.log(`\n--- ${spec.label} id=${spec.id} ---`);
  try {
    const row = await analyzeStrategy(db, spec);
    if (!row) continue;
    buildFindings(row);
    report.legs.push(row);
    console.log(JSON.stringify(row.counts, null, 2));
    console.log('rates/day', row.ratesPerDay);
    row.findings.forEach((x) => console.log('!', x));
  } catch (err) {
    console.error(spec.label, err.message);
    report.legs.push({ label: spec.label, error: err.message });
  }
}

// Global recommendations
const ct = report.legs.filter((l) => l.type === 'CT_Fractal');
const mom = report.legs.find((l) => l.type === 'momentum_scalp_tv');
const zz = report.legs.find((l) => l.type === 'zz_breakout');

if (ct.some((l) => l.counts?.liveEntries > (l.counts?.btEntries || 0) * 5)) {
  report.recommendations.push('CT: enforce closed-bar dedupe audit; compare review_snapshots period vs live window');
  report.recommendations.push('CT: keep FIL/PENDLE/ORDI disabled until bar-replay matches BT on Jul4-7');
}
if (mom?.counts?.liveEntries > (mom?.counts?.btEntries || 0) * 2) {
  report.recommendations.push('Momentum: check cold-start / macro gates; lot differs from card backtest');
}
if (zz) {
  report.recommendations.push('ZZ: historical only — card migrated off zz_breakout Jul4');
}
report.recommendations.push('Reconciliation: refreshBacktestPredictions uses last N bars, not dateFrom — fix to align with live window');
report.recommendations.push('Add CI bar-replay test: computeSignalAtIndex vs live_trade_events per strategy_type');

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));
console.log(`\nWrote ${OUT_JSON}`);

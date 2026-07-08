#!/usr/bin/env node
/**
 * Full vitrine audit: all strategy types on storefront cards.
 * Fleet SQL stats + per-type representative leg live vs backtest.
 *
 *   DB_FILE=... node scripts/hybrid/audit_vitrine_full_jul2026.mjs
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

const DB_FILE = process.env.DB_FILE || path.join(backendRoot, 'database.db');
const DATE_FROM = process.env.DATE_FROM || '2026-07-04';
const DATE_TO = process.env.DATE_TO || '2026-07-07';
const BT_DATE_FROM = process.env.BT_DATE_FROM || '2026-05-01';
const API_KEY = process.env.API_KEY || 'artursk-6323499563-api';
const OUT_JSON = process.env.OUT_JSON || path.join(root, 'tmp', 'audit_vitrine_full_jul2026.json');

const FROM_MS = Date.parse(`${DATE_FROM}T00:00:00Z`);
const TO_MS = Date.parse(`${DATE_TO}T23:59:59Z`) + 1;
const DAYS = Math.max(0.25, (TO_MS - FROM_MS) / 86400_000);

const normMs = (t) => {
  const v = Number(t || 0);
  return v > 0 && v < 1_000_000_000_000 ? v * 1000 : v;
};

const intervalMs = (interval) => {
  const m = String(interval || '15m').match(/^(\d+)([mhd])$/i);
  if (!m) return 15 * 60_000;
  const n = Number(m[1]);
  const u = m[2].toLowerCase();
  if (u === 'h') return n * 3600_000;
  if (u === 'd') return n * 86400_000;
  return n * 60_000;
};

const countSynthCycles = (rows, strategy) => {
  if (String(strategy?.market_mode || '') !== 'synthetic') return rows.length;
  const base = String(strategy.base_symbol || '').toUpperCase().slice(0, 4);
  const barMs = intervalMs(strategy.interval);
  const filtered = rows.filter((r) => String(r.source_symbol || '').toUpperCase().startsWith(base));
  const src = filtered.length ? filtered : rows;
  return new Set(src.map((r) => `${Math.floor(normMs(r.actual_time) / barMs)}|${r.side}`)).size
    || Math.ceil(rows.length / 2);
};

const verdictFor = (livePerDay, btPerDay, synthPerDay, winPct, livePnl) => {
  const ratio = btPerDay > 0 ? livePerDay / btPerDay : (livePerDay > 0.5 ? 99 : 1);
  if (livePerDay < 0.05 && btPerDay < 0.05) return 'idle';
  if (ratio > 8) return 'critical_churn';
  if (ratio > 3) return 'high_churn';
  if (ratio > 1.8) return 'elevated';
  if (winPct < 20 && livePnl < 0) return 'losing';
  if (winPct >= 40 && livePnl >= 0) return 'ok';
  return 'watch';
};

const loadVitrineCards = async (db) => {
  const row = await db.get(
    "SELECT value FROM app_runtime_flags WHERE key='offer.store.algofund_published_system_names'"
  );
  if (!row?.value) return [];
  return JSON.parse(row.value);
};

const fleetStats = async (db) => {
  const types = await db.all(
    `SELECT s.strategy_type AS type,
            COUNT(DISTINCT s.id) AS active_legs,
            COUNT(DISTINCT a.name) AS clients,
            COUNT(DISTINCT ap.published_system_name) AS cards
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
     WHERE s.is_active = 1
     GROUP BY s.strategy_type
     ORDER BY active_legs DESC`
  );

  const liveByType = await db.all(
    `SELECT s.strategy_type AS type,
            COUNT(*) AS raw_fills,
            COUNT(DISTINCT s.id) AS legs_with_trades,
            COUNT(DISTINCT a.name) AS clients_trading,
            SUM(CASE WHEN lte.trade_type='entry' THEN 1 ELSE 0 END) AS entries,
            SUM(CASE WHEN lte.trade_type='exit' THEN 1 ELSE 0 END) AS exits
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
     WHERE COALESCE(lte.event_origin,'exchange_fill') = 'exchange_fill'
       AND lte.actual_time >= ? AND lte.actual_time < ?
     GROUP BY s.strategy_type
     ORDER BY entries DESC`,
    [FROM_MS, TO_MS]
  );

  const pnlByType = await db.all(
    `SELECT s.strategy_type AS type, lte.trade_type, lte.side,
            lte.entry_price, lte.actual_price, lte.position_size, lte.actual_fee,
            s.market_mode, s.base_symbol, s.interval, s.id AS strategy_id
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
     WHERE COALESCE(lte.event_origin,'exchange_fill') = 'exchange_fill'
       AND lte.actual_time >= ? AND lte.actual_time < ?
     ORDER BY lte.actual_time ASC, lte.id ASC`,
    [FROM_MS, TO_MS]
  );

  const pnlMap = new Map();
  const openByKey = new Map();
  const winMap = new Map();
  const tripMap = new Map();
  const synthEntryRows = new Map();

  for (const r of pnlByType) {
    const type = String(r.type || '');
    if (!pnlMap.has(type)) {
      pnlMap.set(type, { gross: 0, fees: 0, trips: 0, wins: 0 });
      winMap.set(type, { wins: 0, total: 0 });
      tripMap.set(type, 0);
      synthEntryRows.set(type, []);
    }
    const side = String(r.side || '').toLowerCase();
    const tt = String(r.trade_type || '').toLowerCase();
    const key = `${r.strategy_id}|${side}`;
    if (tt === 'entry') {
      openByKey.set(key, r);
      synthEntryRows.get(type).push(r);
    } else if (tt === 'exit' && openByKey.has(key)) {
      const ent = openByKey.get(key);
      const qty = Number(ent.position_size || 0);
      const ep = Number(ent.entry_price || 0);
      const xp = Number(r.actual_price || 0);
      const fee = Number(ent.actual_fee || 0) + Number(r.actual_fee || 0);
      const gross = side === 'long' ? (xp - ep) * qty : (ep - xp) * qty;
      const net = gross - fee;
      const bucket = pnlMap.get(type);
      bucket.gross += gross;
      bucket.fees += fee;
      bucket.trips += 1;
      if (net > 0) bucket.wins += 1;
      tripMap.set(type, (tripMap.get(type) || 0) + 1);
      openByKey.delete(key);
    }
  }

  const synthCycles = new Map();
  for (const [type, rows] of synthEntryRows) {
    const byStrategy = new Map();
    for (const r of rows) {
      const sid = r.strategy_id;
      if (!byStrategy.has(sid)) byStrategy.set(sid, []);
      byStrategy.get(sid).push(r);
    }
    let total = 0;
    for (const [sid, rs] of byStrategy) {
      const strat = rs[0];
      total += countSynthCycles(rs, strat);
    }
    synthCycles.set(type, total);
  }

  const byCard = await db.all(
    `SELECT ap.published_system_name AS card, s.strategy_type AS type,
            COUNT(DISTINCT s.id) AS legs,
            SUM(CASE WHEN lte.trade_type='entry' AND lte.actual_time>=? AND lte.actual_time<? THEN 1 ELSE 0 END) AS entries
     FROM algofund_profiles ap
     JOIN api_keys a ON a.name = ap.execution_api_key_name
     JOIN strategies s ON s.api_key_id = a.id AND s.is_active = 1
     LEFT JOIN live_trade_events lte ON lte.strategy_id = s.id
       AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
     WHERE ap.actual_enabled = 1
     GROUP BY ap.published_system_name, s.strategy_type
     ORDER BY card, entries DESC`,
    [FROM_MS, TO_MS]
  );

  const zeroFillClients = await db.all(
    `SELECT ap.execution_api_key_name AS api_key, ap.published_system_name AS card,
            (SELECT COUNT(*) FROM live_trade_events lte
             JOIN strategies s ON s.id=lte.strategy_id
             JOIN api_keys ak ON ak.id=s.api_key_id
             WHERE ak.name=ap.execution_api_key_name
               AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
               AND lte.actual_time >= ?) AS fills_24h_plus
     FROM algofund_profiles ap
     WHERE ap.actual_enabled = 1`,
    [FROM_MS]
  );

  return { types, liveByType, pnlMap, synthCycles, byCard, zeroFillClients };
};

const pickRepresentativeLegs = async (db) => {
  return db.all(
    `SELECT s.strategy_type AS type, s.id, s.name, a.name AS api_key,
            s.interval, s.market_mode, s.base_symbol,
            COUNT(*) AS live_entries
     FROM live_trade_events lte
     JOIN strategies s ON s.id = lte.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name AND ap.actual_enabled = 1
     WHERE lte.trade_type='entry'
       AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
       AND lte.actual_time >= ? AND lte.actual_time < ?
       AND a.name = ?
     GROUP BY s.id
     ORDER BY s.strategy_type, live_entries DESC`,
    [FROM_MS, TO_MS, API_KEY]
  );
};

const analyzeLeg = async (db, leg) => {
  const strategy = await db.get('SELECT * FROM strategies WHERE id=?', [leg.id]);
  if (!strategy) return null;
  const apiKey = leg.api_key || API_KEY;
  await ensureExchangeClientInitialized(apiKey);

  const entryRows = await db.all(
    `SELECT side, entry_time, actual_time, source_symbol FROM live_trade_events
     WHERE strategy_id=? AND trade_type='entry'
       AND COALESCE(event_origin,'exchange_fill')='exchange_fill'
       AND actual_time>=? AND actual_time<?`,
    [leg.id, FROM_MS, TO_MS]
  );
  const isSynth = String(strategy.market_mode) === 'synthetic';
  const base = String(strategy.base_symbol || '').toUpperCase().slice(0, 4);
  const liveLegEntries = isSynth
    ? entryRows.filter((r) => String(r.source_symbol || '').toUpperCase().startsWith(base))
    : entryRows;
  const liveSynth = countSynthCycles(entryRows, strategy);
  const liveCount = liveLegEntries.length;

  let bt;
  try {
    bt = await runBacktest({
      apiKeyName: apiKey,
      mode: 'single',
      strategyId: leg.id,
      dateFrom: BT_DATE_FROM,
      dateTo: DATE_TO,
      bars: 2500,
      warmupBars: 0,
      initialBalance: 10000,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      enablePairLock: false,
    });
  } catch (err) {
    return { ...leg, error: err.message };
  }

  const btAll = bt.trades || [];
  const btWin = btAll.filter((t) => normMs(t.entryTime) >= FROM_MS && normMs(t.entryTime) < TO_MS);
  const btPnl = btWin.reduce((s, t) => s + Number(t.netPnl || 0), 0);

  const iv = intervalMs(strategy.interval);
  const trips = await db.all(
    `SELECT trade_type, side, entry_time, actual_time FROM live_trade_events
     WHERE strategy_id=? AND COALESCE(event_origin,'exchange_fill')='exchange_fill'
       AND actual_time>=? AND actual_time<? ORDER BY actual_time`,
    [leg.id, FROM_MS, TO_MS]
  );
  let churn = 0;
  let tripsN = 0;
  const open = new Map();
  for (const r of trips) {
    const side = String(r.side || '').toLowerCase();
    const tt = String(r.trade_type || '').toLowerCase();
    if (tt === 'entry') open.set(side, r);
    else if (tt === 'exit' && open.has(side)) {
      const hold = normMs(r.actual_time) - normMs(open.get(side).actual_time);
      if (hold >= 0 && hold < iv * 1.5) churn += 1;
      tripsN += 1;
      open.delete(side);
    }
  }

  const livePerDay = (isSynth ? liveSynth : liveCount) / DAYS;
  const btPerDay = btWin.length / DAYS;

  return {
    strategyId: leg.id,
    type: leg.type,
    name: leg.name,
    interval: strategy.interval,
    marketMode: strategy.market_mode,
    symbol: isSynth ? `${strategy.base_symbol}/${strategy.quote_symbol}` : strategy.base_symbol,
    liveRawFills: entryRows.length,
    liveSynthCycles: liveSynth,
    livePerDay: Number(livePerDay.toFixed(2)),
    btPerDay: Number(btPerDay.toFixed(2)),
    liveVsBtRatio: btPerDay > 0 ? Number((livePerDay / btPerDay).toFixed(1)) : (livePerDay > 0 ? null : 0),
    btTradesInWindow: btWin.length,
    btPnlWindow: Number(btPnl.toFixed(2)),
    btWinRateAll: bt.summary?.winRatePercent ?? null,
    fastChurn: tripsN ? `${churn}/${tripsN}` : '0/0',
    verdict: verdictFor(livePerDay, btPerDay, liveSynth, 0, 0),
  };
};

await database.initDB();
const { db } = database;

const cards = await loadVitrineCards(db);
const fleet = await fleetStats(db);
const reps = await pickRepresentativeLegs(db);

const repByType = new Map();
for (const leg of reps) {
  if (!repByType.has(leg.type)) repByType.set(leg.type, leg);
}

const typeAudits = [];
for (const [type, leg] of repByType) {
  console.log(`BT sample: ${type} id=${leg.id}...`);
  typeAudits.push(await analyzeLeg(db, leg));
}

const typeSummary = fleet.types.map((t) => {
  const live = fleet.liveByType.find((x) => x.type === t.type) || {};
  const pnl = fleet.pnlMap.get(t.type) || { gross: 0, fees: 0, trips: 0, wins: 0 };
  const net = pnl.gross - pnl.fees;
  const winPct = pnl.trips > 0 ? (100 * pnl.wins / pnl.trips) : null;
  const rawEntries = Number(live.entries || 0);
  const synthCycles = fleet.synthCycles.get(t.type) ?? rawEntries;
  const normEntries = ['CT_Fractal'].includes(t.type) ? synthCycles : rawEntries;
  const perClient = t.clients > 0 ? normEntries / t.clients : normEntries;
  const perLeg = t.active_legs > 0 ? normEntries / t.active_legs : 0;
  const rep = typeAudits.find((a) => a?.type === t.type && !a.error);
  return {
    type: t.type,
    activeLegs: t.active_legs,
    clients: t.clients,
    cards: t.cards,
    liveRawEntries: rawEntries,
    liveSynthCycles: synthCycles,
    entriesPerClientPerDay: Number((perClient / DAYS).toFixed(2)),
    entriesPerLegPerDay: Number((perLeg / DAYS).toFixed(2)),
    liveNetPnl: Number(net.toFixed(2)),
    liveWinPct: winPct !== null ? Number(winPct.toFixed(1)) : null,
    liveTrips: pnl.trips,
    representative: rep || typeAudits.find((a) => a?.type === t.type) || null,
    verdict: verdictFor(
      perClient / DAYS,
      rep?.btPerDay || 0,
      synthCycles,
      winPct || 0,
      net
    ),
  };
});

const cardRollup = {};
for (const row of fleet.byCard) {
  const card = String(row.card || 'unknown');
  if (!cardRollup[card]) cardRollup[card] = { types: {}, totalEntries: 0 };
  cardRollup[card].types[row.type] = {
    legs: row.legs,
    entries: Number(row.entries || 0),
  };
  cardRollup[card].totalEntries += Number(row.entries || 0);
}

const deadClients = fleet.zeroFillClients.filter((c) => Number(c.fills_24h_plus) === 0);

const report = {
  generatedAt: new Date().toISOString(),
  window: { from: DATE_FROM, to: DATE_TO, days: Number(DAYS.toFixed(2)) },
  sampleApiKey: API_KEY,
  vitrineCards: cards,
  enabledClients: fleet.zeroFillClients.length,
  deadFillClients: deadClients.map((c) => ({ api: c.api_key, card: c.card })),
  strategyTypes: typeSummary,
  cardRollup,
  recommendations: [],
};

for (const t of typeSummary) {
  const r = t.representative;
  if (!r) continue;
  if (r.liveVsBtRatio > 5) {
    report.recommendations.push(`${t.type}: live ${r.livePerDay}/d vs BT ${r.btPerDay}/d (${r.liveVsBtRatio}x) — runtime churn / synth double-count`);
  }
  if (t.liveWinPct !== null && t.liveWinPct < 25 && t.liveNetPnl < -5) {
    report.recommendations.push(`${t.type}: win ${t.liveWinPct}% net $${t.liveNetPnl} — cut worst legs or disable until bar-replay OK`);
  }
}
if (deadClients.length) {
  report.recommendations.push(`${deadClients.length} enabled clients with 0 exchange_fill in window — check BingX hedge / API keys`);
}
report.recommendations.push('Count synth CT as 1 cycle per base-leg bar, not 2 exchange fills');
report.recommendations.push('same_bar_no_reentry deployed — monitor CT/momentum rate next 48h');

fs.mkdirSync(path.dirname(OUT_JSON), { recursive: true });
fs.writeFileSync(OUT_JSON, JSON.stringify(report, null, 2));

console.log('\n=== VITRINE AUDIT ===');
console.log(`Window ${DATE_FROM}..${DATE_TO} | clients ${report.enabledClients}`);
for (const t of typeSummary) {
  console.log(
    `${t.type}: legs=${t.activeLegs} clients=${t.clients} `
    + `live=${t.entriesPerClientPerDay}/client/d net=$${t.liveNetPnl} win=${t.liveWinPct ?? '-'}% `
    + `rep BT=${t.representative?.btPerDay ?? '-'} live=${t.representative?.livePerDay ?? '-'} `
    + `[${t.verdict}]`
  );
}
console.log(`\nWrote ${OUT_JSON}`);

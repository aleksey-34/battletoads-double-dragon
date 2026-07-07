#!/usr/bin/env node
/**
 * Build landing hero demo: best live round-trip trades + real Binance 1h candles.
 * Re-run daily (cron) to rotate showcase trades.
 *
 *   node scripts/admin_tools/build_landing_demo_trades.mjs
 *   DB_PATH=backend/database.db OUT=docs/landing-demo-trades.json node scripts/...
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execFileSync } from 'child_process';
import ccxt from '../../backend/node_modules/ccxt/dist/ccxt.cjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '../..');
const DB_PATH = process.env.DB_PATH || path.join(REPO, 'backend/database.db');
const OUT = process.env.OUT || path.join(REPO, 'docs/landing-demo-trades.json');
const TRADE_LIMIT = Number(process.env.LANDING_TRADE_LIMIT || 4);
const INTERVAL = '1h';
const PAD_BARS = 12;
const EXCHANGE_ID = process.env.LANDING_EXCHANGE || 'okx';

const pickTradesSql = `
WITH exits AS (
  SELECT strategy_id, source_symbol, side, actual_time AS exit_time, actual_price AS exit_price
  FROM live_trade_events
  WHERE trade_type = 'exit' AND source_symbol IS NOT NULL AND source_symbol != '' AND actual_price > 0
),
entries AS (
  SELECT strategy_id, source_symbol, side, actual_time AS entry_time, actual_price AS entry_price
  FROM live_trade_events WHERE trade_type = 'entry' AND actual_price > 0
),
pairs AS (
  SELECT e.strategy_id, e.source_symbol, e.side, en.entry_price, e.exit_price,
    (CASE WHEN e.side='long' THEN (e.exit_price-en.entry_price)/en.entry_price
          ELSE (en.entry_price-e.exit_price)/en.entry_price END)*100 AS pnl_pct,
    en.entry_time, e.exit_time, (e.exit_time - en.entry_time) AS dur_ms
  FROM exits e
  JOIN entries en ON en.strategy_id=e.strategy_id AND en.source_symbol=e.source_symbol
    AND en.entry_time = (
      SELECT MAX(entry_time) FROM entries en2
      WHERE en2.strategy_id=e.strategy_id AND en2.source_symbol=e.source_symbol
        AND en2.entry_time < e.exit_time
    )
  WHERE en.entry_price > 0
    AND ABS(LOG(en.entry_price / e.exit_price)) < 0.5
)
SELECT strategy_id, source_symbol, side, entry_price, exit_price, pnl_pct, entry_time, exit_time
FROM pairs
WHERE pnl_pct BETWEEN 0.5 AND 25 AND dur_ms >= 3600000
ORDER BY pnl_pct DESC
`;

const toCcxtSymbol = (sourceSymbol) => {
  const sym = String(sourceSymbol || '').toUpperCase();
  if (!sym.endsWith('USDT')) return null;
  const base = sym.slice(0, -4);
  return `${base}/USDT:USDT`;
};

const fetchWindow = async (ex, ccxtSymbol, entryMs, exitMs) => {
  const barMs = 3_600_000;
  const startMs = entryMs - PAD_BARS * barMs;
  const endMs = exitMs + PAD_BARS * barMs;
  const all = [];
  let since = startMs;
  while (since <= endMs) {
    const batch = await ex.fetchOHLCV(ccxtSymbol, INTERVAL, since, 500);
    if (!batch?.length) break;
    for (const c of batch) {
      if (c[0] > endMs) break;
      if (!all.length || c[0] > all[all.length - 1][0]) all.push(c);
    }
    const last = batch[batch.length - 1][0];
    if (last <= since) break;
    since = last + barMs;
    if (batch.length < 2) break;
    await new Promise((r) => setTimeout(r, 120));
  }
  return all.filter((c) => c[0] >= startMs && c[0] <= endMs);
};

const compactCandles = (rows) => rows.map((c) => [
  c[0],
  +c[1].toFixed(6),
  +c[2].toFixed(6),
  +c[3].toFixed(6),
  +c[4].toFixed(6),
]);

const queryDb = (sql) => {
  const out = execFileSync('sqlite3', ['-json', DB_PATH, sql], { encoding: 'utf8' }).trim();
  if (!out) return [];
  return JSON.parse(out);
};

const main = async () => {
  if (!fs.existsSync(DB_PATH)) {
    console.error(`DB not found: ${DB_PATH}`);
    process.exit(1);
  }
  const rows = queryDb(pickTradesSql);

  const picked = [];
  const seen = new Set();
  for (const row of rows) {
    const sym = row.source_symbol;
    if (seen.has(sym)) continue;
    if (!toCcxtSymbol(sym)) continue;
    seen.add(sym);
    picked.push(row);
    if (picked.length >= TRADE_LIMIT) break;
  }

  if (!picked.length) {
    console.error('No suitable trades found');
    process.exit(1);
  }

  const ex = new ccxt[EXCHANGE_ID]({ enableRateLimit: true });
  await ex.loadMarkets();
  console.log(`Exchange: ${EXCHANGE_ID}`);

  const trades = [];
  for (const row of picked) {
    const ccxtSymbol = toCcxtSymbol(row.source_symbol);
    const raw = await fetchWindow(ex, ccxtSymbol, row.entry_time, row.exit_time);
    if (raw.length < 8) {
      console.warn(`Skip ${row.source_symbol}: only ${raw.length} candles`);
      continue;
    }
    const short = row.source_symbol.replace(/USDT$/, '');
    const pnl = +Number(row.pnl_pct).toFixed(2);
    const side = String(row.side || 'long');
    trades.push({
      id: `${side}-${short.toLowerCase()}-${row.entry_time}`,
      symbol: row.source_symbol,
      short,
      side,
      pnlPct: pnl,
      entryTime: row.entry_time,
      exitTime: row.exit_time,
      entryPrice: +Number(row.entry_price).toFixed(6),
      exitPrice: +Number(row.exit_price).toFixed(6),
      interval: INTERVAL,
      candles: compactCandles(raw),
      markers: [
        { ts: row.entry_time, price: row.entry_price, type: 'entry', side },
        { ts: row.exit_time, price: row.exit_price, type: 'exit', side },
      ],
    });
    console.log(`  OK ${row.source_symbol} pnl=${pnl}% bars=${raw.length}`);
  }

  if (!trades.length) {
    console.error('Failed to fetch candles for any trade');
    process.exit(1);
  }

  const payload = {
    generatedAt: new Date().toISOString(),
    rotateAfter: new Date(Date.now() + 86400000).toISOString().slice(0, 10),
    sourceDb: path.basename(DB_PATH),
    trades,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(payload, null, 2));
  const jsOut = OUT.replace(/\.json$/i, '.js');
  fs.writeFileSync(jsOut, `window.LANDING_DEMO = ${JSON.stringify(payload)};\n`);
  console.log(`Wrote ${trades.length} trades -> ${OUT}`);
  console.log(`Wrote ${jsOut}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

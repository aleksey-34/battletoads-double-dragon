#!/usr/bin/env node
/**
 * Safe WEEX live pair permission probe (one API key, no fills).
 *
 * For each symbol used by active strategies:
 *  - fetch mark price + min qty
 *  - place LIMIT buy at 5% of mark (will not fill)
 *  - cancel only that order id immediately
 *  - classify: tradable | denied (-1058) | offline | other
 *
 * Usage on VPS:
 *   cd /opt/battletoads-double-dragon/backend
 *   PROBE_API_KEY=artursk-1702322932-api node ../scripts/admin_tools/audit_weex_live_pair_permissions.mjs
 *
 * DRY_RUN=1 — list symbols only, no orders.
 */
import fs from 'fs';
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(root, 'dist/utils/database.js'));
const exchange = require(path.join(root, 'dist/bot/exchange.js'));

const PROBE_API_KEY = String(process.env.PROBE_API_KEY || 'artursk-1702322932-api').trim();
const KEY_PREFIX = String(process.env.KEY_PREFIX || 'artursk%').trim();
const DRY_RUN = String(process.env.DRY_RUN || '0') === '1';
const PRICE_FACTOR = Math.max(0.01, Math.min(0.2, Number(process.env.PRICE_FACTOR || 0.05)));
const SLEEP_MS = Math.max(200, Number(process.env.SLEEP_MS || 800));
const OUT_PATH = process.env.OUT_PATH || path.join(root, '..', 'results', 'weex_pair_permission_audit.json');

const REPLACEMENT_HINTS = {
  AIXBTUSDT: 'UNIUSDT (synth LINK/UNI already in card)',
  TRUUSDT: 'drop mono or use INJUSDT/TIAUSDT decorr leg',
  IPUSDT: 'TIAUSDT (TV burst sub)',
  BERAUSDT: 'BERA mono CT only (drop BERA/IP synth)',
  STXUSDT: 'FILUSDT mono CT',
  'LINKUSDT/AIXBTUSDT': 'LINKUSDT/UNIUSDT',
  'TRUUSDT/GRTUSDT': 'INJUSDT/TIAUSDT',
  'IPUSDT/ZECUSDT': 'drop or ZEC mono',
  'BERAUSDT/IPUSDT': 'BERA mono CT',
  'STXUSDT/IMXUSDT': 'FIL mono CT',
};

const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

const classifyError = (message) => {
  const text = String(message || '').toLowerCase();
  if (text.includes('no permission for this trading pair') || text.includes('-1058')) {
    return 'denied';
  }
  if (text.includes('offline') || text.includes('not found') || text.includes('invalid symbol')) {
    return 'offline';
  }
  if (text.includes('rate limit') || text.includes('429')) {
    return 'rate_limit';
  }
  return 'other';
};

const normalizeSymbol = (raw) => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

await database.initDB();
const { db } = database;
const {
  ensureExchangeClientInitialized,
  getInstrumentInfo,
  getMarketData,
  placeOrder,
  cancelOrderById,
} = exchange;

const rows = await db.all(
  `SELECT DISTINCT UPPER(TRIM(s.base_symbol)) AS sym
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   WHERE LOWER(COALESCE(a.exchange, '')) LIKE '%weex%'
     AND a.name LIKE ?
     AND COALESCE(s.is_active, 0) = 1
     AND COALESCE(s.is_archived, 0) = 0
     AND TRIM(COALESCE(s.base_symbol, '')) <> ''
   UNION
   SELECT DISTINCT UPPER(TRIM(s.quote_symbol)) AS sym
   FROM strategies s
   JOIN api_keys a ON a.id = s.api_key_id
   WHERE LOWER(COALESCE(a.exchange, '')) LIKE '%weex%'
     AND a.name LIKE ?
     AND COALESCE(s.is_active, 0) = 1
     AND COALESCE(s.is_archived, 0) = 0
     AND TRIM(COALESCE(s.quote_symbol, '')) <> ''
   ORDER BY sym`,
  [KEY_PREFIX, KEY_PREFIX],
);

const symbols = [...new Set(rows.map((r) => normalizeSymbol(r.sym)).filter(Boolean))].sort();

console.log(`=== WEEX pair permission audit ===`);
console.log(`probe: ${PROBE_API_KEY}`);
console.log(`symbols: ${symbols.length}`);
console.log(`mode: ${DRY_RUN ? 'DRY_RUN' : `live probe (limit @ ${(PRICE_FACTOR * 100).toFixed(0)}% mark, cancel immediately)`}`);
console.log('');

if (DRY_RUN) {
  for (const sym of symbols) console.log(sym);
  process.exit(0);
}

await ensureExchangeClientInitialized(PROBE_API_KEY);

const results = [];
let tradable = 0;
let denied = 0;
let offline = 0;
let other = 0;

for (const symbol of symbols) {
  const row = { symbol, status: 'unknown', detail: '', orderId: null, mark: null, qty: null, hint: REPLACEMENT_HINTS[symbol] || null };
  try {
    const info = await getInstrumentInfo(PROBE_API_KEY, symbol);
    const minQty = Number.parseFloat(String(info?.lotSizeFilter?.minOrderQty || '0'));
    const qtyStep = Number.parseFloat(String(info?.lotSizeFilter?.qtyStep || '0.001'));
    const qty = Number.isFinite(minQty) && minQty > 0 ? minQty : qtyStep;

    let mark = NaN;
    try {
      const candles = await getMarketData(PROBE_API_KEY, symbol, '1h', 3);
      const last = Array.isArray(candles) && candles.length > 0 ? candles[candles.length - 1] : null;
      if (Array.isArray(last) && last.length >= 5) {
        mark = Number(last[4]);
      } else if (last && typeof last === 'object') {
        mark = Number(last.close);
      }
    } catch {
      mark = NaN;
    }
    if (!Number.isFinite(mark) || mark <= 0) {
      row.status = 'offline';
      row.detail = 'no mark price';
      offline += 1;
      results.push(row);
      console.log(`OFFLINE  ${symbol} — no mark`);
      await sleep(SLEEP_MS);
      continue;
    }

    const limitPrice = mark * PRICE_FACTOR;
    row.mark = mark;
    row.qty = qty;

    const order = await placeOrder(
      PROBE_API_KEY,
      symbol,
      'Buy',
      String(qty),
      String(limitPrice),
      { marketType: 'swap' },
    );

    const orderId = String(order?.id || order?.info?.orderId || '').trim();
    row.orderId = orderId || null;

    if (orderId) {
      try {
        await cancelOrderById(PROBE_API_KEY, symbol, orderId);
      } catch (cancelErr) {
        row.detail = `placed but cancel failed: ${cancelErr.message}`;
        row.status = 'cancel_failed';
        other += 1;
        results.push(row);
        console.log(`WARN     ${symbol} — placed, cancel failed: ${cancelErr.message}`);
        await sleep(SLEEP_MS);
        continue;
      }
    }

    row.status = 'tradable';
    row.detail = `limit buy ${qty} @ ${limitPrice.toFixed(6)} cancelled`;
    tradable += 1;
    console.log(`OK       ${symbol}`);
  } catch (error) {
    const status = classifyError(error?.message);
    row.status = status;
    row.detail = String(error?.message || error).slice(0, 240);
    if (status === 'denied') {
      denied += 1;
      console.log(`DENIED   ${symbol}${row.hint ? ` → hint: ${row.hint}` : ''}`);
    } else if (status === 'offline') {
      offline += 1;
      console.log(`OFFLINE  ${symbol}`);
    } else if (status === 'rate_limit') {
      other += 1;
      console.log(`RATE     ${symbol} — sleeping 5s`);
      await sleep(5000);
    } else {
      other += 1;
      console.log(`ERR      ${symbol} — ${row.detail.slice(0, 100)}`);
    }
  }

  results.push(row);
  await sleep(SLEEP_MS);
}

const summary = {
  generatedAt: new Date().toISOString(),
  probeApiKey: PROBE_API_KEY,
  keyPrefix: KEY_PREFIX,
  priceFactor: PRICE_FACTOR,
  totals: { symbols: symbols.length, tradable, denied, offline, other },
  deniedSymbols: results.filter((r) => r.status === 'denied').map((r) => r.symbol),
  offlineSymbols: results.filter((r) => r.status === 'offline').map((r) => r.symbol),
  results,
};

fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
fs.writeFileSync(OUT_PATH, `${JSON.stringify(summary, null, 2)}\n`);

console.log('');
console.log(`tradable=${tradable} denied=${denied} offline=${offline} other=${other}`);
console.log(`written: ${OUT_PATH}`);

if (denied > 0) {
  console.log('\nDenied (replacement hints only — no auto-migration):');
  for (const r of results.filter((x) => x.status === 'denied')) {
    console.log(`  ${r.symbol} → ${r.hint || 'review manually'}`);
  }
}

process.exit(denied > 0 ? 2 : 0);

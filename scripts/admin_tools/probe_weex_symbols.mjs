#!/usr/bin/env node
/** Probe specific WEEX symbols (limit buy @ 5% mark, cancel immediately). */
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(root, 'dist/utils/database.js'));
const exchange = require(path.join(root, 'dist/bot/exchange.js'));

const PROBE_API_KEY = String(process.env.PROBE_API_KEY || 'artursk-1702322932-api').trim();
const symbols = String(process.env.PROBE_SYMBOLS || 'TONUSDT,COMPUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);
const PRICE_FACTOR = 0.05;
const sleep = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });

await database.initDB();
await exchange.ensureExchangeClientInitialized(PROBE_API_KEY);

let denied = 0;
for (const symbol of symbols) {
  try {
    const info = await exchange.getInstrumentInfo(PROBE_API_KEY, symbol);
    const minQty = Number.parseFloat(String(info?.lotSizeFilter?.minOrderQty || '0.001'));
    const candles = await exchange.getMarketData(PROBE_API_KEY, symbol, '1h', 3);
    const last = candles[candles.length - 1];
    const mark = Array.isArray(last) ? Number(last[4]) : Number(last?.close);
    if (!Number.isFinite(mark) || mark <= 0) throw new Error('no mark price');
    const order = await exchange.placeOrder(
      PROBE_API_KEY,
      symbol,
      'Buy',
      String(minQty),
      String(mark * PRICE_FACTOR),
      { marketType: 'swap' },
    );
    const orderId = String(order?.id || order?.info?.orderId || '').trim();
    if (orderId) await exchange.cancelOrderById(PROBE_API_KEY, symbol, orderId);
    console.log(`OK       ${symbol}`);
  } catch (error) {
    const msg = String(error?.message || error);
    if (msg.includes('-1058') || msg.toLowerCase().includes('no permission')) {
      denied += 1;
      console.log(`DENIED   ${symbol} — ${msg.slice(0, 120)}`);
    } else {
      console.log(`ERR      ${symbol} — ${msg.slice(0, 120)}`);
    }
  }
  await sleep(800);
}

process.exit(denied > 0 ? 2 : 0);

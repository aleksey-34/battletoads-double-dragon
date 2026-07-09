#!/usr/bin/env node
/**
 * Compare WEEX Regular vs Copy Trading API keys (methods + symbols).
 * Usage: node scripts/hybrid/probe_weex_copy_api_jul2026.mjs [Copy_Alex1] [Main_Alex1]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const backendRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(backendRoot, 'dist/utils/database.js'));
const { createWeexClient } = require(path.join(backendRoot, 'dist/bot/weexClient.js'));
const exchange = require(path.join(backendRoot, 'dist/bot/exchange.js'));

const KEYS = process.argv.slice(2);
const DEFAULT_KEYS = ['Copy_Alex1', 'Main_Alex1'];
const TEST_SYMBOLS = (process.env.SYMBOLS || 'BTCUSDT,ETHUSDT,INJUSDT,SUIUSDT,LINKUSDT,VETUSDT,DOGEUSDT,SOLUSDT,NEARUSDT').split(',').map((s) => s.trim());
const INTERVALS = ['15m', '4h', '1h'];

const timed = async (label, fn) => {
  const t0 = Date.now();
  try {
    const result = await fn();
    return { ok: true, ms: Date.now() - t0, result };
  } catch (error) {
    return { ok: false, ms: Date.now() - t0, error: (error).message || String(error) };
  }
};

const summarizeBalances = (rows) => {
  if (!Array.isArray(rows)) return rows;
  return rows
    .filter((r) => Math.abs(Number(r?.free || r?.total || 0)) > 0)
    .slice(0, 8)
    .map((r) => ({
      asset: r.asset || r.currency || r.coin,
      free: Number(r.free ?? r.available ?? 0),
      total: Number(r.total ?? r.equity ?? 0),
    }));
};

await database.initDB();
const { db } = database;
const keys = KEYS.length ? KEYS : DEFAULT_KEYS;
const report = { generatedAt: new Date().toISOString(), keys: {} };

for (const apiKeyName of keys) {
  const row = await db.get('SELECT * FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    report.keys[apiKeyName] = { error: 'api_key not found in database' };
    continue;
  }

  const section = {
    exchange: row.exchange,
    tags: row.tags || null,
    methods: {},
    symbols: {},
  };

  await exchange.ensureExchangeClientInitialized(apiKeyName);
  const client = createWeexClient(row);

  section.methods.balance = await timed('balance', () => exchange.getBalances(apiKeyName));
  section.methods.balanceLegacy = await timed('balanceLegacy', async () => {
    const raw = await client.fetchBalance();
    return summarizeBalances(raw?.info?.data || raw?.total ? Object.keys(raw.total).map((k) => ({ asset: k, total: raw.total[k], free: raw.free?.[k] })) : raw);
  });

  section.methods.positionsAll = await timed('positionsAll', () => exchange.getPositions(apiKeyName));
  section.methods.openOrders = await timed('openOrders', () => client.fetchOpenOrders());

  for (const sym of TEST_SYMBOLS) {
    const symRes = { klines: {}, position: null, ticker: null };
    for (const iv of INTERVALS) {
      symRes.klines[iv] = await timed(`kline_${iv}`, () => exchange.getMarketData(apiKeyName, sym, iv, 5));
    }
    symRes.position = await timed('position', () => exchange.getPositions(apiKeyName, sym));
    symRes.ticker = await timed('ticker', async () => {
      if (typeof client.fetchTicker === 'function') {
        return client.fetchTicker(sym);
      }
      return null;
    });
    section.symbols[sym] = symRes;
  }

  // Permission probe: read-only order endpoint should fail gracefully if no trade perm
  section.methods.setLeverageProbe = await timed('setLeverage_BTC', () => client.setLeverage(5, 'BTCUSDT'));

  report.keys[apiKeyName] = section;
  console.log(`\n=== ${apiKeyName} ===`);
  console.log(JSON.stringify(section, null, 2));
}

const outPath = process.env.OUT || path.join(backendRoot, '..', 'tmp', 'probe_weex_copy_api_jul2026.json');
import fs from 'fs';
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
console.log(`\nWrote ${outPath}`);

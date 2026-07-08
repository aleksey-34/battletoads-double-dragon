#!/usr/bin/env node
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'backend');
const require = createRequire(import.meta.url);
const { initDB } = require(path.join(root, 'dist/utils/database.js'));
const { runBacktest } = require(path.join(root, 'dist/backtest/engine.js'));
const { ensureExchangeClientInitialized } = require(path.join(root, 'dist/bot/exchange.js'));

const FIX_MS = Date.parse('2026-07-07T19:35:00Z');
const legs = [
  [254394, 'NEAR'],
  [253672, 'SUI'],
  [254165, 'EIGEN'],
];

await initDB();
await ensureExchangeClientInitialized('artursk-6323499563-api');
for (const [id, sym] of legs) {
  const bt = await runBacktest({
    apiKeyName: 'artursk-6323499563-api',
    mode: 'single',
    strategyId: id,
    dateFrom: '2026-07-07',
    dateTo: '2026-07-08',
    warmupBars: 0,
    bars: 800,
    enablePairLock: false,
  });
  const sinceFix = (bt.trades || []).filter((t) => Number(t.entryTime) >= FIX_MS);
  console.log(`${sym} id=${id} bt_2d=${bt.trades?.length || 0} since_fix=${sinceFix.length}`);
  sinceFix.forEach((t) => console.log(`  ${t.side} @ ${new Date(t.entryTime).toISOString()}`));
}

#!/usr/bin/env node
/**
 * DCA grid density research: trades/ret vs step/TP/TF/base%.
 * Usage: cd backend && node ../scripts/research_dca_grid_density.mjs
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const require = createRequire(import.meta.url);
await require(path.join(root, 'dist/utils/database.js')).initDB();
const { db } = require(path.join(root, 'dist/utils/database.js'));
const { runBacktest } = require(path.join(root, 'dist/backtest/engine.js'));
const { ensureExchangeClientInitialized } = require(path.join(root, 'dist/bot/exchange.js'));

const apiKey = process.env.BTDD_DCA_KEY || 'BTDD_D1';
const initialBalance = Number(process.env.DCA_DEPOSIT || 1000);
const dateFrom = process.env.DCA_FROM || '2024-06-01';
const dateTo = process.env.DCA_TO || '2026-06-03';

const markets = (process.env.DCA_MARKETS || 'SUIUSDT,TRXUSDT,PEPEUSDT,DOGEUSDT,WIFUSDT,BNBUSDT')
  .split(',')
  .map((s) => s.trim().toUpperCase())
  .filter(Boolean);

const scenarios = [
  { label: 'ui-stale-5pct', interval: '1h', step: 0.2, tp: 0.4, basePct: 5, maxOrders: 20 },
  { label: 'ui-new-10pct', interval: '1h', step: 0.2, tp: 0.4, basePct: 10, maxOrders: 20 },
  { label: 'dense-1h', interval: '1h', step: 0.15, tp: 0.25, basePct: 7, maxOrders: 25 },
  { label: 'ultra-1h', interval: '1h', step: 0.1, tp: 0.18, basePct: 5, maxOrders: 30 },
  { label: 'micro-15m', interval: '15m', step: 0.12, tp: 0.2, basePct: 4, maxOrders: 25 },
  { label: 'insane-15m', interval: '15m', step: 0.12, tp: 0.2, basePct: 4, maxOrders: 30 },
  { label: 'insane-5m', interval: '5m', step: 0.08, tp: 0.12, basePct: 3, maxOrders: 30 },
  { label: 'super-step05', interval: '1h', step: 0.5, tp: 1.0, basePct: 5, maxOrders: 20 },
];

async function upsertDcaStrategy(fullSymbol, sc) {
  const ak = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKey]);
  if (!ak?.id) throw new Error(`api key ${apiKey} not found`);
  const name = `research-dca-${fullSymbol}-${sc.label}`;
  let row = await db.get(
    `SELECT id FROM strategies WHERE api_key_id=? AND name=? LIMIT 1`,
    [ak.id, name],
  );
  const params = [sc.basePct, sc.step, sc.maxOrders, sc.tp, sc.interval];
  if (row?.id) {
    await db.run(
      `UPDATE strategies SET dca_base_amount_percent=?, dca_step_percent=?, dca_max_orders=?,
       dca_tp_percent=?, interval=?, dca_entry_filter='always', dca_sl_percent=0, strategy_type='dca'
       WHERE id=?`,
      [...params, row.id],
    );
    return row.id;
  }
  const ins = await db.run(
    `INSERT INTO strategies (name, api_key_id, base_symbol, strategy_type, is_active, interval,
      dca_base_amount_usdt, dca_base_amount_percent, dca_step_percent, dca_max_orders,
      dca_order_multiplier, dca_tp_percent, dca_sl_percent, dca_entry_filter, long_enabled, short_enabled)
     VALUES (?, ?, ?, 'dca', 1, ?, 50, ?, ?, ?, 1, ?, 0, 'always', 1, 0)`,
    [name, ak.id, fullSymbol, sc.interval, sc.basePct, sc.step, sc.maxOrders, sc.tp],
  );
  return ins.lastID;
}

await ensureExchangeClientInitialized(apiKey);

console.log(`DCA grid research  ${dateFrom} → ${dateTo}  deposit=${initialBalance}  key=${apiKey}\n`);
console.log('market\tscenario\tret%\tdd%\tpf\ttrades\tfinal');

for (const market of markets) {
  for (const sc of scenarios) {
    try {
      const sid = await upsertDcaStrategy(market, sc);
      const r = await runBacktest({
        apiKeyName: apiKey,
        strategyIds: [sid],
        mode: 'portfolio',
        dateFrom,
        dateTo,
        initialBalance,
        skipMissingSymbols: true,
      });
      const s = r.summary;
      console.log([
        market,
        sc.label,
        s.totalReturnPercent.toFixed(2),
        s.maxDrawdownPercent.toFixed(2),
        s.profitFactor.toFixed(2),
        s.tradesCount,
        s.finalEquity.toFixed(1),
      ].join('\t'));
    } catch (e) {
      console.log([market, sc.label, 'ERR', String(e.message || e).slice(0, 80)].join('\t'));
    }
  }
}

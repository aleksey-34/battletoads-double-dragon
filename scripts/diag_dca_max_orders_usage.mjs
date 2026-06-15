#!/usr/bin/env node
/**
 * Compare DCA backtest: how much maxOrders=8 vs 20 changes results (isolated pair).
 * Also estimates typical safety-order depth from step/TP math.
 *
 * Usage: cd backend && node ../scripts/diag_dca_max_orders_usage.mjs [market]
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const require = createRequire(import.meta.url);
const database = require(path.join(root, 'dist/utils/database.js'));
await database.initDB();
const { db } = database;
const { runBacktest } = require(path.join(root, 'dist/backtest/engine.js'));
const { ensureExchangeClientInitialized } = require(path.join(root, 'dist/bot/exchange.js'));

const market = (process.argv[2] || 'SUIUSDT').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/USDT$/, '') + 'USDT';
const apiKey = process.env.BTDD_DCA_KEY || 'BTDD_D1';
const initialBalance = 1000;
const dateFrom = '2024-06-01';
const dateTo = '2026-06-01';

const scenarios = [
  { label: 'aggressive-ui', step: 0.3, tp: 0.7, basePct: 5, maxOrders: 20, interval: '1h' },
  { label: 'maxOrders-8', step: 0.3, tp: 0.7, basePct: 5, maxOrders: 8, interval: '1h' },
  { label: 'maxOrders-12', step: 0.3, tp: 0.7, basePct: 5, maxOrders: 12, interval: '1h' },
  { label: 'base-8pct', step: 0.3, tp: 0.7, basePct: 8, maxOrders: 12, interval: '1h' },
  { label: 'base-10pct', step: 0.3, tp: 0.7, basePct: 10, maxOrders: 12, interval: '1h' },
];

const theoreticalMaxSafetiesBeforeTp = (stepPct, tpPct) => {
  // Long-only DCA: each safety at -step% from last buy; TP when close >= avg*(1+tp%).
  // Rough upper bound if price falls in straight line without bounce.
  let last = 100;
  let legs = [100];
  let safeties = 0;
  for (let i = 0; i < 25; i += 1) {
    const avg = legs.reduce((a, b) => a + b, 0) / legs.length;
    const tpAt = avg * (1 + tpPct / 100);
    if (tpAt >= last * 0.999) {
      return { safeties, reason: 'tp_would_hit_before_next_safety' };
    }
    const next = last * (1 - stepPct / 100);
    legs.push(next);
    safeties += 1;
    last = next;
  }
  return { safeties: 25, reason: 'cap' };
};

async function findOrCreateDcaStrategy(apiKeyName, fullSymbol, settings) {
  const row = await db.get(
    `SELECT id FROM strategies WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
     AND base_symbol = ? AND strategy_type = 'dca' LIMIT 1`,
    [apiKeyName, fullSymbol],
  );
  if (row?.id) {
    await db.run(
      `UPDATE strategies SET dca_base_amount_usdt=?, dca_base_amount_percent=?, dca_step_percent=?,
       dca_max_orders=?, dca_order_multiplier=1, dca_tp_percent=?, dca_sl_percent=0,
       dca_entry_filter='always', interval=?, is_active=1, strategy_type='dca'
       WHERE id=?`,
      [50, settings.basePct, settings.step, settings.maxOrders, settings.tp, settings.interval, row.id],
    );
    return row.id;
  }
  const ak = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  const ins = await db.run(
    `INSERT INTO strategies (name, api_key_id, base_symbol, strategy_type, is_active, interval,
      dca_base_amount_usdt, dca_base_amount_percent, dca_step_percent, dca_max_orders,
      dca_order_multiplier, dca_tp_percent, dca_sl_percent, dca_entry_filter, long_enabled, short_enabled)
     VALUES (?, ?, ?, 'dca', 1, ?, 50, ?, ?, ?, 1, ?, 0, 'always', 1, 0)`,
    [`diag-dca-${fullSymbol}`, ak.id, fullSymbol, settings.interval, settings.basePct, settings.step, settings.maxOrders, settings.tp],
  );
  return ins.lastID;
}

await ensureExchangeClientInitialized(apiKey);

console.log(`Market ${market}  deposit ${initialBalance}  ${dateFrom} -> ${dateTo}\n`);
console.log('Theoretical straight-drop safeties before TP (upper bound, not typical):');
for (const [step, tp] of [[0.3, 0.7], [0.3, 0.8], [0.5, 1.0]]) {
  const t = theoreticalMaxSafetiesBeforeTp(step, tp);
  console.log(`  step ${step}% TP ${tp}% -> up to ~${t.safeties} доборов (${t.reason})`);
}
console.log('\nBacktest comparison (isolated DCA pair, % base of equity):\n');
console.log('label           maxOrd  base%   ret%     DD%    trades  finalEq');

for (const sc of scenarios) {
  const sid = await findOrCreateDcaStrategy(apiKey, market, sc);
  const raw = await runBacktest({
    apiKeyName: apiKey,
    strategyIds: [sid],
    mode: 'portfolio',
    dateFrom,
    dateTo,
    initialBalance,
    reinvestPercentOverride: 100,
    maxDepositOverride: initialBalance * 20,
  });
  const ret = Number(raw.summary?.totalReturnPercent || 0).toFixed(2);
  const dd = Number(raw.summary?.maxDrawdownPercent || 0).toFixed(2);
  const tr = Number(raw.summary?.tradesCount || 0);
  const fe = Number(raw.summary?.finalEquity || 0).toFixed(0);
  console.log(
    `${sc.label.padEnd(15)} ${String(sc.maxOrders).padStart(5)} ${String(sc.basePct).padStart(5)} ${ret.padStart(8)} ${dd.padStart(7)} ${String(tr).padStart(7)} ${fe.padStart(8)}`,
  );
}

console.log('\nВывод: если ret при maxOrders 8 ≈ ret при 20 — потолок 20 не используется; лучше поднять base%.');

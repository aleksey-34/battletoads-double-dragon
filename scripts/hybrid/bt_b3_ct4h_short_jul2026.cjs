#!/usr/bin/env node
/** Short B3 CT4h BT table (bars=2400). */
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
process.env.HYBRID_QUIET = '1';
process.env.LOG_CONSOLE_LEVEL = 'error';
if (!process.env.HYBRID_CANDLE_DIR && fs.existsSync(path.join(REPO, 'results/hybrid_candle_bundle'))) {
  process.env.HYBRID_CANDLE_DIR = path.join(REPO, 'results/hybrid_candle_bundle');
}
const database = require(path.join(backendRoot, 'dist/utils/database'));
const exchange = require(path.join(backendRoot, 'dist/bot/exchange'));
const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));

(async () => {
  await database.initDB();
  try { await exchange.ensureExchangeClientInitialized('BTDD_D1'); } catch (e) { console.warn(String(e.message || e)); }
  const { db } = database;
  const rows = await db.all(`
    SELECT s.id, s.strategy_type, s.interval, s.base_symbol, s.quote_symbol
    FROM trading_system_members m
    JOIN trading_systems ts ON ts.id = m.system_id
    JOIN strategies s ON s.id = m.strategy_id
    WHERE ts.name LIKE '%synth-stable-union-v4-4-b3%'
    ORDER BY 2,3,4`);
  console.error('legs', rows.length);
  const sets = {
    full_b3: rows.map((r) => r.id),
    ct_all: rows.filter((r) => r.strategy_type === 'CT_Fractal').map((r) => r.id),
    ct_4h: rows.filter((r) => r.strategy_type === 'CT_Fractal' && r.interval === '4h').map((r) => r.id),
    ct_1d: rows.filter((r) => r.strategy_type === 'CT_Fractal' && r.interval === '1d').map((r) => r.id),
    momentum_15m: rows.filter((r) => r.strategy_type === 'momentum_scalp_tv').map((r) => r.id),
    full_no_churn: rows.filter((r) => {
      if (r.strategy_type !== 'CT_Fractal' || r.interval !== '4h') return true;
      const p = `${r.base_symbol}/${r.quote_symbol || ''}`;
      return !['LINKUSDT/UNIUSDT', 'HBARUSDT/VETUSDT'].includes(p);
    }).map((r) => r.id),
  };
  const base = {
    apiKeyName: 'BTDD_D1', mode: 'portfolio', dateFrom: '2024-06-01', bars: 2400, warmupBars: 120,
    initialBalance: 10000, commissionPercent: 0.1, slippagePercent: 0.05, maxOpenPositions: 12,
    maxDepositOverride: 8500, reinvestPercentOverride: 50, enablePairLock: true, skipMissingSymbols: true,
    lotPercentOverride: 28.6,
  };
  const out = [];
  for (const [name, sids] of Object.entries(sets)) {
    if (!sids.length) continue;
    console.error('run', name, sids.length);
    const t0 = Date.now();
    const r = await runBacktest({ ...base, strategyIds: sids });
    const s = r.summary || {};
    const row = {
      name, legs: sids.length, ms: Date.now() - t0,
      ret: +Number(s.totalReturnPercent || 0).toFixed(2),
      dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
      pf: +Number(s.profitFactor || 0).toFixed(2),
      trades: Number(s.tradesCount || 0),
      wr: +Number(s.winRatePercent || 0).toFixed(1),
    };
    out.push(row);
    console.log(JSON.stringify(row));
  }
  fs.mkdirSync(path.join(REPO, 'tmp'), { recursive: true });
  fs.writeFileSync(path.join(REPO, 'tmp', 'b3_ct4h_bt_short_jul2026.json'), JSON.stringify({ results: out }, null, 2));
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

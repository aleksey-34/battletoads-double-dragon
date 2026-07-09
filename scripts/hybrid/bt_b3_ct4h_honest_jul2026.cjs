#!/usr/bin/env node
/**
 * Honest B3 portfolio BT with current master composition (CT 4h+1d, momentum 15m).
 */
const path = require('path');
const fs = require('fs');
const REPO = path.join(__dirname, '..', '..');
const backendRoot = path.join(REPO, 'backend');
process.env.HYBRID_QUIET = process.env.HYBRID_QUIET || '1';
process.env.LOG_CONSOLE_LEVEL = process.env.LOG_CONSOLE_LEVEL || 'error';
// Prefer local candle bundles when present (multi-TF dirs).
if (!process.env.HYBRID_CANDLE_DIR) {
  const candidates = [
    path.join(REPO, 'results/hybrid_candle_bundle'),
    path.join(REPO, 'results/hybrid_candle_bundle_v2'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      process.env.HYBRID_CANDLE_DIR = c;
      break;
    }
  }
}
const database = require(path.join(backendRoot, 'dist/utils/database'));
const { runBacktest } = require(path.join(backendRoot, 'dist/backtest/engine'));
const exchange = require(path.join(backendRoot, 'dist/bot/exchange'));

(async () => {
  await database.initDB();
  const { db } = database;
  try {
    await exchange.ensureExchangeClientInitialized('BTDD_D1');
  } catch (e) {
    console.warn('ensureExchangeClientInitialized failed (candle bundle may still work):', e.message || e);
  }
  const rows = await db.all(`
    SELECT s.id, s.strategy_type, s.interval, s.base_symbol, s.quote_symbol, s.name
    FROM trading_system_members m
    JOIN trading_systems ts ON ts.id = m.system_id
    JOIN strategies s ON s.id = m.strategy_id
    WHERE ts.name LIKE '%synth-stable-union-v4-4-b3%'
    ORDER BY s.strategy_type, s.interval, s.base_symbol
  `);
  const all = rows.map((r) => r.id);
  const sets = {
    full_b3: all,
    ct_all: rows.filter((r) => r.strategy_type === 'CT_Fractal').map((r) => r.id),
    ct_4h: rows.filter((r) => r.strategy_type === 'CT_Fractal' && r.interval === '4h').map((r) => r.id),
    ct_1d: rows.filter((r) => r.strategy_type === 'CT_Fractal' && r.interval === '1d').map((r) => r.id),
    momentum_15m: rows.filter((r) => r.strategy_type === 'momentum_scalp_tv').map((r) => r.id),
    full_no_churn: rows
      .filter((r) => {
        if (r.strategy_type !== 'CT_Fractal' || r.interval !== '4h') return true;
        const pair = `${r.base_symbol}/${r.quote_symbol || ''}`;
        return !['LINKUSDT/UNIUSDT', 'HBARUSDT/VETUSDT'].includes(pair);
      })
      .map((r) => r.id),
  };

  const base = {
    apiKeyName: 'BTDD_D1',
    mode: 'portfolio',
    dateFrom: '2024-06-01',
    bars: 4800,
    warmupBars: 120,
    initialBalance: 10000,
    commissionPercent: 0.1,
    slippagePercent: 0.05,
    fundingRatePercent: 0,
    maxOpenPositions: 12,
    maxDepositOverride: 8500,
    reinvestPercentOverride: 50,
    enablePairLock: true,
    skipMissingSymbols: true,
  };

  const configs = [
    { name: 'full_b3_lot28.6', sids: sets.full_b3, lot: 28.6 },
    { name: 'full_b3_op80_lot52', sids: sets.full_b3, lot: 52 },
    { name: 'full_no_churn_lot28.6', sids: sets.full_no_churn, lot: 28.6 },
    { name: 'ct_all_lot28.6', sids: sets.ct_all, lot: 28.6 },
    { name: 'ct_4h_lot28.6', sids: sets.ct_4h, lot: 28.6 },
    { name: 'ct_1d_lot28.6', sids: sets.ct_1d, lot: 28.6 },
    { name: 'momentum_15m_lot28.6', sids: sets.momentum_15m, lot: 28.6 },
  ];

  const out = {
    generatedAt: new Date().toISOString(),
    composition: rows.map((r) => ({
      id: r.id,
      type: r.strategy_type,
      iv: r.interval,
      market: r.quote_symbol ? `${r.base_symbol}/${r.quote_symbol}` : r.base_symbol,
    })),
    results: [],
  };

  for (const cfg of configs) {
    if (!cfg.sids.length) continue;
    const t0 = Date.now();
    const r = await runBacktest({
      ...base,
      strategyIds: cfg.sids,
      lotPercentOverride: cfg.lot,
    });
    const s = r.summary || {};
    const row = {
      name: cfg.name,
      legs: cfg.sids.length,
      lot: cfg.lot,
      ms: Date.now() - t0,
      ret: +Number(s.totalReturnPercent || 0).toFixed(2),
      dd: +Number(s.maxDrawdownPercent || 0).toFixed(2),
      pf: +Number(s.profitFactor || 0).toFixed(2),
      trades: Number(s.tradesCount || 0),
      wr: +Number(s.winRatePercent || 0).toFixed(1),
      finalEquity: +Number(s.finalEquity || 0).toFixed(2),
    };
    out.results.push(row);
    console.log(JSON.stringify(row));
  }

  const outPath = path.join(__dirname, '..', '..', 'tmp', 'b3_ct4h_bt_jul2026.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log('WROTE', outPath);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

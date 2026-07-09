#!/usr/bin/env node
/**
 * Honest card BT after momentum ADX+close-exit parity.
 * Compares: mom-only vs full B3 vs B3 without churn CT pairs.
 *
 *   cd backend && npm run build && node ../scripts/hybrid/bt_cards_momentum_parity_jul2026.cjs
 */
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

const CHURN_PAIRS = new Set(['LINKUSDT/UNIUSDT', 'HBARUSDT/VETUSDT']);

async function loadMembers(db, like) {
  return db.all(`
    SELECT s.id, s.strategy_type, s.interval, s.base_symbol, s.quote_symbol, s.market_mode
    FROM trading_system_members m
    JOIN trading_systems ts ON ts.id = m.system_id
    JOIN strategies s ON s.id = m.strategy_id
    WHERE ts.name LIKE ? AND m.is_enabled = 1
    ORDER BY s.id`, [like]);
}

const pairKey = (r) => {
  const q = String(r.quote_symbol || '').trim();
  return q ? `${r.base_symbol}/${q}` : `${r.base_symbol}/-`;
};

(async () => {
  await database.initDB();
  try { await exchange.ensureExchangeClientInitialized('BTDD_D1'); } catch (e) { console.warn(String(e.message || e)); }
  const { db } = database;

  const b3 = await loadMembers(db, '%synth-stable-union-v4-4-b3%');
  const l400 = await loadMembers(db, '%tv-momentum-cloud-1-2-l400-op8%');
  console.error('loaded', { b3: b3.length, l400: l400.length });

  const b3Mom = b3.filter((r) => r.strategy_type === 'momentum_scalp_tv');
  const b3NoChurn = b3.filter((r) => {
    if (r.strategy_type !== 'CT_Fractal') return true;
    return !CHURN_PAIRS.has(pairKey(r));
  });
  const b3MomOnly = b3Mom;
  const l400Mom = l400.filter((r) => r.strategy_type === 'momentum_scalp_tv');

  const configs = [
    { name: 'B3_full_mild_lot28.6_op12', sids: b3.map((r) => r.id), lot: 28.6, op: 12, reinvest: 50 },
    { name: 'B3_noChurnCT_mild_lot28.6_op12', sids: b3NoChurn.map((r) => r.id), lot: 28.6, op: 12, reinvest: 50 },
    { name: 'B3_momOnly_mild_lot28.6_op12', sids: b3MomOnly.map((r) => r.id), lot: 28.6, op: 12, reinvest: 50 },
    { name: 'L400_mom_mild_lot28.6_op8', sids: l400Mom.map((r) => r.id), lot: 28.6, op: 8, reinvest: 50 },
    { name: 'L400_vitrine_lot400_op8', sids: l400Mom.map((r) => r.id), lot: 400, op: 8, reinvest: 75 },
  ];

  const out = [];
  for (const cfg of configs) {
    if (!cfg.sids.length) {
      console.error('skip empty', cfg.name);
      continue;
    }
    console.error('run', cfg.name, 'n=', cfg.sids.length);
    const t0 = Date.now();
    const r = await runBacktest({
      apiKeyName: 'BTDD_D1',
      mode: 'portfolio',
      strategyIds: cfg.sids,
      dateFrom: '2024-06-01',
      dateTo: '2026-07-05',
      bars: 4800,
      warmupBars: 120,
      initialBalance: 10000,
      commissionPercent: 0.1,
      slippagePercent: 0.05,
      maxOpenPositions: cfg.op,
      lotPercentOverride: cfg.lot,
      reinvestPercent: cfg.reinvest,
      maxDepositGrowthEnabled: true,
    });
    const s = r?.summary || r?.portfolioSummary || {};
    const row = {
      name: cfg.name,
      n: cfg.sids.length,
      ms: Date.now() - t0,
      ret: s.totalReturnPercent ?? s.returnPercent ?? null,
      dd: s.maxDrawdownPercent ?? s.maxDrawdown ?? null,
      trades: s.tradesCount ?? s.totalTrades ?? null,
      pf: s.profitFactor ?? null,
      wr: s.winRatePercent ?? null,
      finalEquity: s.finalEquity ?? null,
    };
    console.error(JSON.stringify(row));
    out.push(row);
  }

  const outPath = path.join(REPO, 'results', 'momentum_parity_cards_jul2026.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), note: 'close-exit momentum parity', rows: out }, null, 2));
  console.log(JSON.stringify(out, null, 2));
  console.error('wrote', outPath);
  process.exit(0);
})().catch((e) => { console.error(e); process.exit(1); });

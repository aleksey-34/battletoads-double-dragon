#!/usr/bin/env node
/**
 * Compare TS portfolio backtest: synthetic-only vs mono-only vs balanced-v2 snapshot.
 *
 * Usage (from repo root, after backend build):
 *   cd backend && npm run build && cd ..
 *   node scripts/run_synthetic_ts_backtest.mjs
 *
 * Env:
 *   TS_API_KEY=BTDD_D1
 *   TS_DATE_FROM=2024-06-01  TS_DATE_TO=2026-06-03
 *   TS_SYNTH_LIMIT=10  TS_MONO_LIMIT=10
 *   TS_REINVEST=100
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const require = createRequire(import.meta.url);
await require(path.join(root, 'dist/utils/database.js')).initDB();

const {
  loadCatalogAndSweepWithFallback,
  previewAdminSweepBacktest,
} = require(path.join(root, 'dist/saas/service.js'));
const { ensureExchangeClientInitialized } = require(path.join(root, 'dist/bot/exchange.js'));

const apiKey = process.env.TS_API_KEY || 'BTDD_D1';
const dateFrom = process.env.TS_DATE_FROM || '2024-06-01';
const dateTo = process.env.TS_DATE_TO || '2026-06-03';
const synthLimit = Math.max(1, Math.min(20, Number(process.env.TS_SYNTH_LIMIT || 10)));
const monoLimit = Math.max(1, Math.min(20, Number(process.env.TS_MONO_LIMIT || 10)));
const reinvestPercent = Number(process.env.TS_REINVEST ?? 100);
const initialBalance = Number(process.env.TS_DEPOSIT || 10000);
const balancedSystem = process.env.TS_BALANCED_SYSTEM
  || 'ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2';

const isMono = (row) => String(row.marketMode || '').toLowerCase() === 'mono';
const offerIdFromRecord = (row) => {
  const mode = isMono(row) ? 'mono' : 'synth';
  const type = String(row.strategyType || 'strategy').toLowerCase();
  return `offer_${mode}_${type}_${row.strategyId}`;
};

const pickTop = (rows, limit, monoOnly) => {
  const pool = rows
    .filter((row) => (monoOnly ? isMono(row) : !isMono(row)))
    .filter((row) => Number(row.strategyId || 0) > 0)
    .sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
  const seen = new Set();
  const out = [];
  for (const row of pool) {
    const market = String(row.market || '').trim();
    if (market && seen.has(market)) continue;
    seen.add(market);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
};

const summarize = (label, result) => {
  const preview = result?.preview?.summary || result?.summary || result;
  const offers = result?.selectedOffers || [];
  const source = String(result?.preview?.source || result?.rerun?.executed ? 'rerun' : 'preset/snapshot');
  const rerun = result?.rerun || {};
  const processed = Number(preview?.processedStrategies ?? 0);
  const skipped = Number(preview?.skippedStrategies ?? 0);
  const modes = offers.map((o) => o.mode || o.familyMode || '?').join(',');
  console.log(
    [
      label,
      `ret ${Number(preview?.totalReturnPercent ?? 0).toFixed(2)}%`,
      `dd ${Number(preview?.maxDrawdownPercent ?? 0).toFixed(2)}%`,
      `pf ${Number(preview?.profitFactor ?? 0).toFixed(2)}`,
      `trades ${Number(preview?.tradesCount ?? 0)}`,
      `offers ${offers.length}`,
      processed > 0 ? `ran ${processed}` : '',
      skipped > 0 ? `skip ${skipped}` : '',
      `src ${source}`,
      rerun.executed ? `key ${rerun.apiKeyName || '?'}` : '',
      modes ? `modes[${modes.slice(0, 60)}${modes.length > 60 ? '…' : ''}]` : '',
    ].filter(Boolean).join('\t'),
  );
  if (skipped > 0 && processed < offers.length) {
    console.log(`  ⚠ ${skipped} стратегий без данных (часто Client not initialized — перезапусти после фикса)`);
  }
};

const runPortfolio = async (label, offerIds, extra = {}) => {
  const ids = Array.isArray(offerIds) ? offerIds : [];
  console.log(`\n--- ${label} (${ids.length || 'snapshot'} offers) ---`);
  ids.slice(0, 5).forEach((id) => console.log(`  ${id}`));
  if (ids.length > 5) console.log(`  … +${ids.length - 5} more`);
  const payload = {
    kind: 'algofund-ts',
    setKey: extra.setKey || 'ts-research-compare',
    forceOfferIds: extra.forceOfferIds === true,
    systemName: extra.systemName,
    dateFrom,
    dateTo,
    initialBalance,
    reinvestPercent,
    preferRealBacktest: true,
    rerunApiKeyName: apiKey,
    riskScore: 8,
    tradeFrequencyScore: 5,
    maxOpenPositions: 10,
  };
  if (ids.length > 0) {
    payload.offerIds = ids;
  }
  const result = await previewAdminSweepBacktest(payload);
  summarize(label, result);
  return result;
};

const { sweep } = await loadCatalogAndSweepWithFallback();
if (!sweep) {
  console.error('Sweep data unavailable');
  process.exit(1);
}

const evaluated = Array.isArray(sweep.evaluated) && sweep.evaluated.length > 0
  ? sweep.evaluated
  : (sweep.topAll || []);

const synthRows = pickTop(evaluated, synthLimit, false);
const monoRows = pickTop(evaluated, monoLimit, true);
const synthOfferIds = synthRows.map(offerIdFromRecord);
const monoOfferIds = monoRows.map(offerIdFromRecord);

await ensureExchangeClientInitialized(apiKey);

console.log(`TS compare  ${dateFrom} → ${dateTo}  key=${apiKey}  reinvest=${reinvestPercent}%`);
console.log(`Sweep evaluated: ${evaluated.length}  synth picked: ${synthOfferIds.length}  mono picked: ${monoOfferIds.length}`);
console.log('Важно: сравнивай только прогоны с src admin_sweep_rerun / snapshot rerun и skip≈0');

if (synthOfferIds.length === 0) {
  console.error('No synthetic offers in sweep — run historical sweep first');
  process.exit(1);
}

await runPortfolio('SYNTHETIC TS (stat_arb / hedge pairs)', synthOfferIds, {
  setKey: 'synthetic-ts-research',
  forceOfferIds: true,
});

if (monoOfferIds.length > 0) {
  await runPortfolio('MONO TS (same count, top mono)', monoOfferIds, {
    setKey: 'mono-ts-research',
    forceOfferIds: true,
  });
}

await runPortfolio('BALANCED-V2 (saved snapshot = mostly mono)', null, {
  systemName: balancedSystem,
  setKey: 'balanced-portfolio-v2',
});

console.log('\nDone. To publish a synth-heavy TS card, pick offerIds from SYNTHETIC run and save a new snapshot setKey.');

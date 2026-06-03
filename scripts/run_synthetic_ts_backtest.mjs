#!/usr/bin/env node
/**
 * Compare TS portfolio: synthetic vs mono vs balanced-v2 snapshot.
 * Picks only 1h/2h/4h strategies (Bybit demo has no 1d history in ranged fetch).
 *
 *   cd backend && npm run build && cd ..
 *   node scripts/run_synthetic_ts_backtest.mjs
 */
import path from 'path';
import { createRequire } from 'module';
import { fileURLToPath } from 'url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend');
const require = createRequire(import.meta.url);
await require(path.join(root, 'dist/utils/database.js')).initDB();

const {
  loadCatalogAndSweepWithFallback,
  loadLatestSweep,
  previewAdminSweepBacktest,
} = require(path.join(root, 'dist/saas/service.js'));
const { ensureExchangeClientInitialized } = require(path.join(root, 'dist/bot/exchange.js'));

const apiKey = process.env.TS_API_KEY || 'BTDD_D1';
const dateFrom = process.env.TS_DATE_FROM || '2024-06-01';
const dateTo = process.env.TS_DATE_TO || '2026-06-03';
const portfolioSize = Math.max(1, Math.min(20, Number(process.env.TS_PORTFOLIO_SIZE || process.env.TS_SYNTH_LIMIT || 10)));
const reinvestPercent = Number(process.env.TS_REINVEST ?? 100);
const initialBalance = Number(process.env.TS_DEPOSIT || 10000);
const balancedSystem = process.env.TS_BALANCED_SYSTEM
  || 'ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2';
const allowedIntervals = new Set(
  String(process.env.TS_INTERVALS || '1h,2h,4h')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),
);

const isMono = (row) => String(row.marketMode || '').toLowerCase() === 'mono';
const normInterval = (row) => String(row.interval || '').trim().toLowerCase();

const offerIdFromRecord = (row) => {
  const mode = isMono(row) ? 'mono' : 'synth';
  const type = String(row.strategyType || 'strategy').toLowerCase();
  return `offer_${mode}_${type}_${row.strategyId}`;
};

const synthTypeRank = (row) => {
  const t = String(row.strategyType || '').toLowerCase();
  if (t === 'stat_arb_zscore') return 0;
  if (t === 'dd_battletoads') return 1;
  if (t === 'zz_breakout') return 2;
  return 3;
};

const pickTop = (rows, limit, monoOnly) => {
  const pool = rows
    .filter((row) => (monoOnly ? isMono(row) : !isMono(row)))
    .filter((row) => Number(row.strategyId || 0) > 0)
    .filter((row) => allowedIntervals.has(normInterval(row)))
    .filter((row) => Number(row.totalReturnPercent ?? 0) > 0 || row.robust === true)
    .sort((a, b) => {
      const robustDelta = Number(Boolean(b.robust)) - Number(Boolean(a.robust));
      if (robustDelta !== 0) return robustDelta;
      if (!monoOnly) {
        const typeDelta = synthTypeRank(a) - synthTypeRank(b);
        if (typeDelta !== 0) return typeDelta;
      }
      const retDelta = Number(b.totalReturnPercent || 0) - Number(a.totalReturnPercent || 0);
      if (Math.abs(retDelta) > 0.01) return retDelta;
      return Number(b.score || 0) - Number(a.score || 0);
    });

  const seenMarkets = new Set();
  const out = [];
  for (const row of pool) {
    const market = String(row.market || '').trim();
    if (market && seenMarkets.has(market)) continue;
    seenMarkets.add(market);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
};

const logPicks = (label, rows) => {
  console.log(`\n${label} (${rows.length}):`);
  for (const row of rows) {
    console.log(
      `  #${row.strategyId} ${row.strategyType} ${normInterval(row)} ${row.market} `
      + `ret=${Number(row.totalReturnPercent || 0).toFixed(1)}% score=${Number(row.score || 0).toFixed(2)}`,
    );
  }
};

const summarize = (label, result) => {
  const preview = result?.preview?.summary || result?.summary || result;
  const offers = result?.selectedOffers || [];
  const rerun = result?.rerun || {};
  const processed = Number(preview?.processedStrategies ?? 0);
  const skipped = Number(preview?.skippedStrategies ?? 0);
  const ok = rerun.executed && skipped === 0 && processed === offers.length;
  console.log(
    [
      label,
      `ret ${Number(preview?.totalReturnPercent ?? 0).toFixed(2)}%`,
      `dd ${Number(preview?.maxDrawdownPercent ?? 0).toFixed(2)}%`,
      `pf ${Number(preview?.profitFactor ?? 0).toFixed(2)}`,
      `trades ${Number(preview?.tradesCount ?? 0)}`,
      `offers ${offers.length}`,
      `ran ${processed}`,
      skipped > 0 ? `skip ${skipped}` : 'skip 0',
      ok ? 'OK' : 'WARN',
    ].join('\t'),
  );
  if (!ok) {
    console.log(`  ⚠ incomplete rerun — check interval/symbol data on ${rerun.apiKeyName || apiKey}`);
  }
};

const runPortfolio = async (label, offerIds, extra = {}) => {
  const ids = Array.isArray(offerIds) ? offerIds : [];
  console.log(`\n--- ${label} ---`);
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
  if (ids.length > 0) payload.offerIds = ids;
  const result = await previewAdminSweepBacktest(payload);
  summarize(label, result);
  return result;
};

const diskSweep = loadLatestSweep();
const { sweep: fallbackSweep } = await loadCatalogAndSweepWithFallback();
const sweep = diskSweep || fallbackSweep;
if (!sweep) {
  console.error('Sweep data unavailable');
  process.exit(1);
}

const evaluated = [
  ...(Array.isArray(sweep.evaluated) ? sweep.evaluated : []),
  ...(Array.isArray(sweep.topAll) ? sweep.topAll : []),
  ...(Array.isArray(sweep.topByMode?.synth) ? sweep.topByMode.synth : []),
  ...(Array.isArray(sweep.topByMode?.mono) ? sweep.topByMode.mono : []),
];
const byStrategyId = new Map();
for (const row of evaluated) {
  const id = Number(row.strategyId || 0);
  if (id > 0 && !byStrategyId.has(id)) byStrategyId.set(id, row);
}
const uniqueRows = [...byStrategyId.values()];

const synthRows = pickTop(uniqueRows, portfolioSize, false);
const monoRows = pickTop(uniqueRows, portfolioSize, true);
const synthOfferIds = synthRows.map(offerIdFromRecord);
const monoOfferIds = monoRows.map(offerIdFromRecord);

await ensureExchangeClientInitialized(apiKey);

console.log(`TS compare  ${dateFrom} → ${dateTo}  key=${apiKey}  size=${portfolioSize}  intervals=${[...allowedIntervals].join(',')}`);
console.log(`Sweep pool: ${uniqueRows.length} unique strategies (disk=${Boolean(diskSweep)})`);

logPicks('SYNTH picks', synthRows);
logPicks('MONO picks', monoRows);

if (synthOfferIds.length === 0) {
  console.error('No synthetic offers after interval filter — widen TS_INTERVALS or rerun sweep');
  process.exit(1);
}

await runPortfolio('SYNTHETIC TS', synthOfferIds, {
  setKey: 'synthetic-ts-research',
  forceOfferIds: true,
});

if (monoOfferIds.length > 0) {
  await runPortfolio('MONO TS (matched size)', monoOfferIds, {
    setKey: 'mono-ts-research',
    forceOfferIds: true,
  });
}

await runPortfolio('BALANCED-V2 snapshot', null, {
  systemName: balancedSystem,
  setKey: 'balanced-portfolio-v2',
});

console.log('\nDone.');

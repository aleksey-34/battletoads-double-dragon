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
const portfolioSize = Math.max(6, Math.min(24, Number(process.env.TS_PORTFOLIO_SIZE || process.env.TS_SYNTH_LIMIT || 18)));
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

const SYNTH_TYPES = ['stat_arb_zscore', 'dd_battletoads', 'zz_breakout'];
const minPerSynthType = Math.max(1, Math.min(6, Number(process.env.TS_MIN_PER_TYPE || 3)));

const rowScore = (row) => {
  const robust = row.robust === true ? 1 : 0;
  const ret = Number(row.totalReturnPercent || 0);
  const pf = Number(row.profitFactor || 0);
  const trades = Number(row.tradesCount || row.trades || 0);
  const dd = Number(row.maxDrawdownPercent || 99);
  const score = Number(row.score || 0);
  return [robust, ret, pf, trades, -dd, score];
};

const compareRows = (a, b) => {
  const sa = rowScore(a);
  const sb = rowScore(b);
  for (let i = 0; i < sa.length; i += 1) {
    if (sb[i] !== sa[i]) return sb[i] - sa[i];
  }
  return 0;
};

const isRatioSynth = (row) => !isMono(row) && String(row.market || '').includes('/');

const passesSynthFilters = (row) => {
  if (!isRatioSynth(row)) return false;
  const pf = Number(row.profitFactor || 0);
  const trades = Number(row.tradesCount || row.trades || 0);
  if (trades < 10) return false;
  if (pf < 0.95 && row.robust !== true) return false;
  return SYNTH_TYPES.includes(String(row.strategyType || '').toLowerCase());
};

const bestPerMarket = (rows) => {
  const byMarket = new Map();
  for (const row of rows) {
    const market = String(row.market || '').trim();
    if (!market) continue;
    const prev = byMarket.get(market);
    if (!prev || compareRows(row, prev) < 0) byMarket.set(market, row);
  }
  return [...byMarket.values()];
};

const pickDiversifiedSynth = (rows, limit) => {
  const byType = Object.fromEntries(
    SYNTH_TYPES.map((t) => [
      t,
      bestPerMarket(
        rows
          .filter((row) => Number(row.strategyId || 0) > 0)
          .filter((row) => allowedIntervals.has(normInterval(row)))
          .filter(passesSynthFilters)
          .filter((row) => String(row.strategyType || '').toLowerCase() === t),
      ),
    ]),
  );
  for (const t of SYNTH_TYPES) byType[t].sort(compareRows);

  const picked = [];
  const seenIds = new Set();
  const seenKeys = new Set();
  const tryAdd = (row) => {
    const sid = Number(row.strategyId || 0);
    const market = String(row.market || '').trim();
    const st = String(row.strategyType || '').toLowerCase();
    const key = `${market}::${st}`;
    if (seenIds.has(sid) || seenKeys.has(key)) return false;
    picked.push(row);
    seenIds.add(sid);
    seenKeys.add(key);
    return true;
  };

  const perType = Math.max(1, Math.min(minPerSynthType, Math.floor(limit / SYNTH_TYPES.length) || 1));
  for (const t of SYNTH_TYPES) {
    let n = 0;
    for (const row of byType[t]) {
      if (n >= perType) break;
      if (tryAdd(row)) n += 1;
    }
  }

  let typeIdx = 0;
  while (picked.length < limit) {
    const t = SYNTH_TYPES[typeIdx % SYNTH_TYPES.length];
    typeIdx += 1;
    let added = false;
    for (const row of byType[t]) {
      if (picked.length >= limit) break;
      if (tryAdd(row)) {
        added = true;
        break;
      }
    }
    if (!added && typeIdx > SYNTH_TYPES.length * 50) break;
  }
  return picked.slice(0, limit);
};

const pickTop = (rows, limit, monoOnly) => {
  if (!monoOnly) return pickDiversifiedSynth(rows, limit);

  const pool = rows
    .filter((row) => isMono(row))
    .filter((row) => Number(row.strategyId || 0) > 0)
    .filter((row) => allowedIntervals.has(normInterval(row)))
    .filter((row) => Number(row.totalReturnPercent ?? 0) > 0 || row.robust === true)
    .sort(compareRows);

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
  const byType = {};
  const byInterval = {};
  console.log(`\n${label} (${rows.length}):`);
  for (const row of rows) {
    const t = String(row.strategyType || '').toLowerCase();
    const iv = normInterval(row);
    byType[t] = (byType[t] || 0) + 1;
    byInterval[iv] = (byInterval[iv] || 0) + 1;
    console.log(
      `  #${row.strategyId} ${row.strategyType} ${iv} ${row.market} `
      + `ret=${Number(row.totalReturnPercent || 0).toFixed(1)}% score=${Number(row.score || 0).toFixed(2)}`,
    );
  }
  console.log(`  by type: ${JSON.stringify(byType)}  by interval: ${JSON.stringify(byInterval)}`);
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

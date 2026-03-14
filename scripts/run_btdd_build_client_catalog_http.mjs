#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { DEFAULT_API_KEY_NAME, DEFAULT_AUTH_PASSWORD, DEFAULT_BASE_URL } from './btdd_http_defaults.mjs';

const API_KEY_NAME = process.env.API_KEY_NAME || DEFAULT_API_KEY_NAME;
const API_BASE_URL = process.env.BASE_URL || DEFAULT_BASE_URL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || DEFAULT_AUTH_PASSWORD;

const SWEEP_RESULT_FILE = String(process.env.SWEEP_RESULT_FILE || '').trim();
const OUTPUT_FILE = String(process.env.OUTPUT_FILE || '').trim();

const TOP_MONO = Math.max(1, Number(process.env.TOP_MONO || 6));
const TOP_SYNTH = Math.max(1, Number(process.env.TOP_SYNTH || 6));
const TOP_ADMIN_TS = Math.max(2, Number(process.env.TOP_ADMIN_TS || 6));

const ONLY_ROBUST = String(process.env.ONLY_ROBUST || '1').trim() === '1';
const UNIQUE_MARKET = String(process.env.UNIQUE_MARKET || '1').trim() === '1';
const ENRICH_EQUITY = String(process.env.ENRICH_EQUITY || '1').trim() === '1';
const ENRICH_MAX_ITEMS = Math.max(0, Number(process.env.ENRICH_MAX_ITEMS || 12));
const MAX_CHART_POINTS = Math.max(50, Number(process.env.MAX_CHART_POINTS || 320));

const DATE_FROM = String(process.env.DATE_FROM || '').trim();
const DATE_TO = String(process.env.DATE_TO || '').trim();
const BACKTEST_BARS = Math.max(120, Number(process.env.BACKTEST_BARS || 6000));
const WARMUP_BARS = Math.max(0, Number(process.env.WARMUP_BARS || 400));
const SKIP_MISSING_SYMBOLS = String(process.env.SKIP_MISSING_SYMBOLS || '1').trim() === '1';

const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 10000);
const COMMISSION = Number(process.env.COMMISSION || 0.1);
const SLIPPAGE = Number(process.env.SLIPPAGE || 0.05);
const FUNDING = Number(process.env.FUNDING || 0);

const headers = {
  Authorization: `Bearer ${AUTH_PASSWORD}`,
  'Content-Type': 'application/json',
};

function nowIso() {
  return new Date().toISOString();
}

function parseNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeRecords(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => ({
    strategyId: Number(row?.strategyId || 0),
    strategyName: String(row?.strategyName || ''),
    strategyType: String(row?.strategyType || ''),
    marketMode: String(row?.marketMode || ''),
    market: String(row?.market || '').toUpperCase(),
    interval: String(row?.interval || '4h'),
    length: Number(row?.length || 0),
    takeProfitPercent: parseNumber(row?.takeProfitPercent || 0),
    detectionSource: String(row?.detectionSource || 'close'),
    zscoreEntry: parseNumber(row?.zscoreEntry || 0),
    zscoreExit: parseNumber(row?.zscoreExit || 0),
    zscoreStop: parseNumber(row?.zscoreStop || 0),
    totalReturnPercent: parseNumber(row?.totalReturnPercent || 0),
    maxDrawdownPercent: parseNumber(row?.maxDrawdownPercent || 0),
    winRatePercent: parseNumber(row?.winRatePercent || 0),
    profitFactor: parseNumber(row?.profitFactor || 0),
    tradesCount: parseNumber(row?.tradesCount || 0),
    score: parseNumber(row?.score || 0),
    robust: row?.robust === true,
  })).filter((row) => row.strategyId > 0 && row.strategyType && row.marketMode && row.market);
}

function discoverLatestSweepResult() {
  if (SWEEP_RESULT_FILE) {
    const explicit = path.resolve(process.cwd(), SWEEP_RESULT_FILE);
    return fs.existsSync(explicit) ? explicit : '';
  }

  const resultsDir = path.resolve(process.cwd(), 'results');
  if (!fs.existsSync(resultsDir)) {
    return '';
  }

  const files = fs
    .readdirSync(resultsDir)
    .filter((name) => new RegExp(`^${API_KEY_NAME.toLowerCase()}_historical_sweep_.*\\.json$`, 'i').test(name))
    .map((name) => ({
      filePath: path.join(resultsDir, name),
      mtimeMs: fs.statSync(path.join(resultsDir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.length > 0 ? files[0].filePath : '';
}

function pickTopByMode(records, mode, takeCount) {
  const modeRows = records.filter((item) => item.marketMode === mode);
  const robustRows = modeRows.filter((item) => item.robust);
  const pool = ONLY_ROBUST && robustRows.length > 0 ? robustRows : modeRows;

  const sorted = [...pool].sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.totalReturnPercent !== a.totalReturnPercent) return b.totalReturnPercent - a.totalReturnPercent;
    return b.profitFactor - a.profitFactor;
  });

  const out = [];
  const used = new Set();

  for (const row of sorted) {
    const key = UNIQUE_MARKET ? row.market : `${row.market}|${row.strategyType}`;
    if (used.has(key)) {
      continue;
    }

    used.add(key);
    out.push(row);

    if (out.length >= takeCount) {
      break;
    }
  }

  return out;
}

function shortTypeLabel(strategyType) {
  if (strategyType === 'stat_arb_zscore') {
    return 'StatArb Z-Score';
  }
  if (strategyType === 'zz_breakout') {
    return 'ZZ Breakout';
  }
  return 'DD BattleToads';
}

function modeLabel(mode) {
  return mode === 'synth' ? 'Синтетическая' : 'Моно';
}

function buildDescriptionRu(record) {
  const type = shortTypeLabel(record.strategyType);
  const mode = modeLabel(record.marketMode);

  if (record.strategyType === 'stat_arb_zscore') {
    return `${mode} стратегия ${type} по рынку ${record.market} (L=${record.length}, entry=${record.zscoreEntry}, exit=${record.zscoreExit}, stop=${record.zscoreStop}).`;
  }

  return `${mode} стратегия ${type} по рынку ${record.market} (L=${record.length}, TP=${record.takeProfitPercent}, source=${record.detectionSource}).`;
}

function pickPreset(rows, comparator) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return null;
  }

  const sorted = [...rows].sort(comparator);
  return sorted[0] || null;
}

function compactPreset(record) {
  if (!record) {
    return null;
  }

  return {
    strategyId: record.strategyId,
    strategyName: record.strategyName,
    score: Number(record.score.toFixed(4)),
    metrics: {
      ret: Number(record.totalReturnPercent.toFixed(2)),
      pf: Number(record.profitFactor.toFixed(2)),
      dd: Number(record.maxDrawdownPercent.toFixed(2)),
      wr: Number(record.winRatePercent.toFixed(2)),
      trades: Math.round(record.tradesCount),
    },
    params: {
      interval: record.interval,
      length: record.length,
      takeProfitPercent: record.takeProfitPercent,
      detectionSource: record.detectionSource,
      zscoreEntry: record.zscoreEntry,
      zscoreExit: record.zscoreExit,
      zscoreStop: record.zscoreStop,
    },
  };
}

function buildSliderPresets(base, allRecords) {
  const peers = allRecords.filter(
    (item) =>
      item.market === base.market &&
      item.marketMode === base.marketMode &&
      item.strategyType === base.strategyType
  );

  const riskLow = pickPreset(peers, (a, b) => {
    if (a.maxDrawdownPercent !== b.maxDrawdownPercent) return a.maxDrawdownPercent - b.maxDrawdownPercent;
    return b.score - a.score;
  });

  const riskMid = pickPreset(peers, (a, b) => b.score - a.score);

  const riskHigh = pickPreset(peers, (a, b) => {
    if (b.totalReturnPercent !== a.totalReturnPercent) return b.totalReturnPercent - a.totalReturnPercent;
    return b.score - a.score;
  });

  const freqLow = pickPreset(peers, (a, b) => {
    if (a.tradesCount !== b.tradesCount) return a.tradesCount - b.tradesCount;
    return b.score - a.score;
  });

  const freqMid = riskMid;

  const freqHigh = pickPreset(peers, (a, b) => {
    if (b.tradesCount !== a.tradesCount) return b.tradesCount - a.tradesCount;
    return b.score - a.score;
  });

  return {
    risk: {
      low: compactPreset(riskLow),
      medium: compactPreset(riskMid),
      high: compactPreset(riskHigh),
    },
    tradeFrequency: {
      low: compactPreset(freqLow),
      medium: compactPreset(freqMid),
      high: compactPreset(freqHigh),
    },
  };
}

function downsampleEquity(points, maxPoints) {
  const rows = Array.isArray(points) ? points : [];
  if (rows.length === 0) {
    return [];
  }

  const normalized = rows
    .map((item) => ({
      time: Number(item?.time || 0),
      equity: parseNumber(item?.equity || 0),
    }))
    .filter((item) => Number.isFinite(item.time) && Number.isFinite(item.equity) && item.time > 0);

  if (normalized.length <= maxPoints) {
    return normalized;
  }

  if (maxPoints <= 1) {
    return [normalized[normalized.length - 1]];
  }

  const out = [];
  const step = (normalized.length - 1) / (maxPoints - 1);

  for (let i = 0; i < maxPoints; i += 1) {
    const idx = Math.min(normalized.length - 1, Math.round(i * step));
    out.push(normalized[idx]);
  }

  return out;
}

async function api(method, route, body) {
  const response = await fetch(`${API_BASE_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await response.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw new Error(`${method} ${route} invalid JSON: ${text.slice(0, 300)}`);
    }
  }

  if (!response.ok) {
    const message = payload?.error || `${response.status} ${response.statusText}`;
    throw new Error(`${method} ${route} failed: ${message}`);
  }

  return payload;
}

async function fetchEquityForStrategy(strategyId, sweepConfig) {
  const payload = await api('POST', '/backtest/run', {
    apiKeyName: API_KEY_NAME,
    mode: 'single',
    strategyId,
    bars: BACKTEST_BARS > 0 ? BACKTEST_BARS : Number(sweepConfig?.backtestBars || 6000),
    dateFrom: DATE_FROM || sweepConfig?.dateFrom || undefined,
    dateTo: DATE_TO || sweepConfig?.dateTo || undefined,
    warmupBars: WARMUP_BARS,
    skipMissingSymbols: SKIP_MISSING_SYMBOLS,
    initialBalance: INITIAL_BALANCE,
    commissionPercent: COMMISSION,
    slippagePercent: SLIPPAGE,
    fundingRatePercent: FUNDING,
    saveResult: false,
  });

  const result = payload?.result || {};
  const summary = result?.summary || {};
  const equityCurve = downsampleEquity(result?.equityCurve || [], MAX_CHART_POINTS);

  return {
    summary: {
      finalEquity: parseNumber(summary?.finalEquity || 0),
      totalReturnPercent: parseNumber(summary?.totalReturnPercent || 0),
      maxDrawdownPercent: parseNumber(summary?.maxDrawdownPercent || 0),
      winRatePercent: parseNumber(summary?.winRatePercent || 0),
      profitFactor: parseNumber(summary?.profitFactor || 0),
      tradesCount: parseNumber(summary?.tradesCount || 0),
    },
    equityCurve,
    equityPointsOriginal: Array.isArray(result?.equityCurve) ? result.equityCurve.length : 0,
  };
}

function buildCatalogRow(record, allRecords) {
  return {
    offerId: `offer_${record.marketMode}_${record.strategyType}_${record.strategyId}`,
    titleRu: `${modeLabel(record.marketMode)} ${shortTypeLabel(record.strategyType)} ${record.market}`,
    descriptionRu: buildDescriptionRu(record),
    strategy: {
      id: record.strategyId,
      name: record.strategyName,
      type: record.strategyType,
      mode: record.marketMode,
      market: record.market,
      params: {
        interval: record.interval,
        length: record.length,
        takeProfitPercent: record.takeProfitPercent,
        detectionSource: record.detectionSource,
        zscoreEntry: record.zscoreEntry,
        zscoreExit: record.zscoreExit,
        zscoreStop: record.zscoreStop,
      },
    },
    metrics: {
      ret: Number(record.totalReturnPercent.toFixed(2)),
      pf: Number(record.profitFactor.toFixed(2)),
      dd: Number(record.maxDrawdownPercent.toFixed(2)),
      wr: Number(record.winRatePercent.toFixed(2)),
      trades: Math.round(record.tradesCount),
      score: Number(record.score.toFixed(2)),
      robust: record.robust,
    },
    sliderPresets: buildSliderPresets(record, allRecords),
  };
}

function uniqueAdminMembers(rows, maxMembers) {
  const sorted = [...rows].sort((a, b) => b.score - a.score);
  const out = [];
  const usedMarkets = new Set();
  const usedTypes = new Set();

  for (const row of sorted) {
    if (out.length >= maxMembers) {
      break;
    }

    if (!usedTypes.has(row.strategyType)) {
      out.push(row);
      usedTypes.add(row.strategyType);
      usedMarkets.add(row.market);
      continue;
    }

    if (!usedMarkets.has(row.market)) {
      out.push(row);
      usedMarkets.add(row.market);
      continue;
    }
  }

  for (const row of sorted) {
    if (out.length >= maxMembers) {
      break;
    }

    if (!out.find((item) => item.strategyId === row.strategyId)) {
      out.push(row);
    }
  }

  return out.slice(0, maxMembers);
}

async function main() {
  const startedAt = Date.now();

  const sourceFile = discoverLatestSweepResult();
  if (!sourceFile) {
    throw new Error('Sweep result JSON not found. Set SWEEP_RESULT_FILE explicitly.');
  }

  const sweep = JSON.parse(fs.readFileSync(sourceFile, 'utf-8'));
  const records = normalizeRecords(sweep?.evaluated || []);

  if (records.length === 0) {
    throw new Error(`No evaluated strategies in ${sourceFile}`);
  }

  const monoRows = pickTopByMode(records, 'mono', TOP_MONO);
  const synthRows = pickTopByMode(records, 'synth', TOP_SYNTH);

  const catalogMono = monoRows.map((row) => buildCatalogRow(row, records));
  const catalogSynth = synthRows.map((row) => buildCatalogRow(row, records));
  const allCatalogRows = [...catalogMono, ...catalogSynth];

  if (ENRICH_EQUITY) {
    const maxToEnrich = Math.min(ENRICH_MAX_ITEMS, allCatalogRows.length);

    for (let i = 0; i < maxToEnrich; i += 1) {
      const row = allCatalogRows[i];
      try {
        const enriched = await fetchEquityForStrategy(row.strategy.id, sweep?.config || {});
        row.equity = {
          source: 'single_backtest',
          generatedAt: nowIso(),
          points: enriched.equityCurve,
          pointsOriginal: enriched.equityPointsOriginal,
          summary: enriched.summary,
        };
        console.log(
          `[EQUITY ${i + 1}/${maxToEnrich}] ${row.strategy.name} points=${row.equity.points.length}/${row.equity.pointsOriginal}`
        );
      } catch (error) {
        row.equity = {
          source: 'single_backtest',
          generatedAt: nowIso(),
          error: error instanceof Error ? error.message : String(error),
          points: [],
        };
        console.log(`[EQUITY_FAIL ${i + 1}/${maxToEnrich}] ${row.strategy.name}: ${row.equity.error}`);
      }
    }
  }

  const robustRows = records.filter((item) => item.robust);
  const adminPool = robustRows.length > 0 ? robustRows : records;
  const adminMembers = uniqueAdminMembers(adminPool, TOP_ADMIN_TS).map((row, index) => ({
    strategyId: row.strategyId,
    strategyName: row.strategyName,
    strategyType: row.strategyType,
    marketMode: row.marketMode,
    market: row.market,
    score: Number(row.score.toFixed(2)),
    weight: index === 0 ? 1.25 : index === 1 ? 1.1 : 1,
  }));

  const output = {
    timestamp: nowIso(),
    apiKeyName: API_KEY_NAME,
    source: {
      sweepFile: sourceFile,
      sweepTimestamp: sweep?.timestamp || null,
    },
    config: {
      topMono: TOP_MONO,
      topSynth: TOP_SYNTH,
      topAdminTs: TOP_ADMIN_TS,
      onlyRobust: ONLY_ROBUST,
      uniqueMarket: UNIQUE_MARKET,
      enrichEquity: ENRICH_EQUITY,
      enrichMaxItems: ENRICH_MAX_ITEMS,
      maxChartPoints: MAX_CHART_POINTS,
    },
    counts: {
      evaluated: records.length,
      robust: robustRows.length,
      monoCatalog: catalogMono.length,
      synthCatalog: catalogSynth.length,
      adminTsMembers: adminMembers.length,
      durationSec: Math.round((Date.now() - startedAt) / 1000),
    },
    clientCatalog: {
      mono: catalogMono,
      synth: catalogSynth,
    },
    adminTradingSystemDraft: {
      name: `ADMIN_TS_${API_KEY_NAME}_${String(nowIso()).slice(0, 10)}`,
      members: adminMembers,
      sourcePortfolioSummary: Array.isArray(sweep?.portfolioResults) ? sweep.portfolioResults : [],
    },
  };

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = nowIso().replace(/[:.]/g, '-');
  const outputPath = OUTPUT_FILE
    ? path.resolve(process.cwd(), OUTPUT_FILE)
    : path.join(outDir, `${API_KEY_NAME.toLowerCase()}_client_catalog_${stamp}.json`);

  fs.writeFileSync(outputPath, JSON.stringify(output, null, 2));

  console.log('--- CLIENT CATALOG SUMMARY ---');
  console.log(`Sweep source: ${sourceFile}`);
  console.log(`Catalog mono: ${catalogMono.length}`);
  console.log(`Catalog synth: ${catalogSynth.length}`);
  console.log(`Admin TS members: ${adminMembers.length}`);
  console.log(`Saved: ${outputPath}`);
}

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

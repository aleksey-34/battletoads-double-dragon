#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { DEFAULT_API_KEY_NAME, DEFAULT_AUTH_PASSWORD, DEFAULT_BASE_URL } from './btdd_http_defaults.mjs';

const API_KEY_NAME = process.env.API_KEY_NAME || DEFAULT_API_KEY_NAME;
const API_BASE_URL = process.env.BASE_URL || DEFAULT_BASE_URL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || DEFAULT_AUTH_PASSWORD;

const DATE_FROM = process.env.DATE_FROM || '2025-01-01T00:00:00Z';
const DATE_TO = String(process.env.DATE_TO || '').trim();

const INTERVAL = String(process.env.INTERVAL || '4h').trim() || '4h';
const BACKTEST_BARS = Math.max(120, Number(process.env.BACKTEST_BARS || 6000));
const WARMUP_BARS = Math.max(0, Number(process.env.WARMUP_BARS || 400));
const SKIP_MISSING_SYMBOLS = String(process.env.SKIP_MISSING_SYMBOLS || '1').trim() === '1';

const EXHAUSTIVE_MODE = String(process.env.EXHAUSTIVE_MODE || '0').trim() === '1';
const ALLOW_DUPLICATE_MARKETS = String(process.env.ALLOW_DUPLICATE_MARKETS || '0').trim() === '1';

const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 10000);
const COMMISSION = Number(process.env.COMMISSION || 0.1);
const SLIPPAGE = Number(process.env.SLIPPAGE || 0.05);
const FUNDING = Number(process.env.FUNDING || 0);

const MAX_RUNS_RAW = Number(process.env.MAX_RUNS || 240);
const MAX_RUNS = Number.isFinite(MAX_RUNS_RAW) ? Math.floor(MAX_RUNS_RAW) : 240;
const MAX_VARIANTS_PER_MARKET_TYPE = Math.max(2, Number(process.env.MAX_VARIANTS_PER_MARKET_TYPE || 8));
const MAX_MEMBERS = Math.max(2, Number(process.env.MAX_MEMBERS || 6));

const TOP_SYNTH_UNIVERSE = Math.max(0, Number(process.env.TOP_SYNTH_UNIVERSE || 12));
const TOP_MONO_UNIVERSE = Math.max(0, Number(process.env.TOP_MONO_UNIVERSE || 12));

const ROBUST_MIN_PF = Number(process.env.ROBUST_MIN_PF || 1.15);
const ROBUST_MAX_DD = Number(process.env.ROBUST_MAX_DD || 22);
const ROBUST_MIN_TRADES = Number(process.env.ROBUST_MIN_TRADES || 40);

const SYSTEM_NAME =
  process.env.SYSTEM_NAME ||
  `HISTSWEEP ${API_KEY_NAME} ${String(DATE_FROM).slice(0, 10)} Candidate`;
const STRATEGY_PREFIX = process.env.STRATEGY_PREFIX || 'HISTSWEEP';

const STRATEGY_TYPES = String(
  process.env.STRATEGY_TYPES || 'DD_BattleToads,stat_arb_zscore,zz_breakout'
)
  .split(',')
  .map((item) => item.trim())
  .filter((item) => item === 'DD_BattleToads' || item === 'stat_arb_zscore' || item === 'zz_breakout');

const DONCH_LEN_GRID = parseNumberGrid(process.env.DONCH_LEN_GRID || '5,8,12,16,24,36');
const DONCH_TP_GRID = parseNumberGrid(process.env.DONCH_TP_GRID || '2,3,4,5,7.5,10');
const DONCH_SRC_GRID = parseSourceGrid(process.env.DONCH_SRC_GRID || 'close,wick');

const STAT_LEN_GRID = parseNumberGrid(process.env.STAT_LEN_GRID || '24,36,48,72,96,120');
const STAT_ENTRY_GRID = parseNumberGrid(process.env.STAT_ENTRY_GRID || '1.25,1.5,1.75,2,2.25');
const STAT_EXIT_GRID = parseNumberGrid(process.env.STAT_EXIT_GRID || '0.5,0.75,1');
const STAT_STOP_GRID = parseNumberGrid(process.env.STAT_STOP_GRID || '2.5,3,3.5');

const PORTFOLIO_WINDOWS_DAYS = parseNumberGrid(process.env.PORTFOLIO_WINDOWS_DAYS || '365,180,90')
  .map((value) => Math.floor(value))
  .filter((value) => value > 0);

const SWEEP_FILE = String(process.env.SWEEP_FILE || '').trim();
const ADDITIONAL_SYNTH = parseMarketGrid(process.env.ADDITIONAL_SYNTH || '');
const ADDITIONAL_MONO = parseMarketGrid(process.env.ADDITIONAL_MONO || '');

const FALLBACK_SYNTH = [
  'IPUSDT/ZECUSDT',
  'ORDIUSDT/ZECUSDT',
  'MERLUSDT/SOMIUSDT',
  'AUCTIONUSDT/MERLUSDT',
  'BERAUSDT/ZECUSDT',
  'IPUSDT/SOMIUSDT',
  'GRTUSDT/INJUSDT',
  'TRUUSDT/GRTUSDT',
  'STXUSDT/INJUSDT',
  'VETUSDT/GRTUSDT',
];

const FALLBACK_MONO = [
  'BERAUSDT',
  'IPUSDT',
  'ORDIUSDT',
  'GRTUSDT',
  'INJUSDT',
  'TRUUSDT',
  'STXUSDT',
  'VETUSDT',
  'AUCTIONUSDT',
  'MERLUSDT',
  'ZECUSDT',
  'SOMIUSDT',
];

const headers = {
  Authorization: `Bearer ${AUTH_PASSWORD}`,
  'Content-Type': 'application/json',
};

function parseNumberGrid(text) {
  return String(text || '')
    .split(',')
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item));
}

function parseSourceGrid(text) {
  return String(text || '')
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item === 'close' || item === 'wick');
}

function parseMarketGrid(text) {
  return String(text || '')
    .split(',')
    .map((item) => item.trim().toUpperCase())
    .filter((item) => item.length > 0);
}

function nowIso() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function api(method, route, body, attempt = 1) {
  const res = await fetch(`${API_BASE_URL}${route}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  let payload = {};

  if (text) {
    try {
      payload = JSON.parse(text);
    } catch (_error) {
      throw new Error(`${method} ${route} invalid JSON: ${text.slice(0, 300)}`);
    }
  }

  if (!res.ok) {
    const message = payload?.error || `${res.status} ${res.statusText}`;

    if (res.status === 429 && attempt < 6) {
      const waitMs = attempt * 1000;
      console.log(`[WAIT] ${method} ${route} got 429, retry in ${waitMs}ms`);
      await sleep(waitMs);
      return api(method, route, body, attempt + 1);
    }

    throw new Error(`${method} ${route} failed: ${message}`);
  }

  return payload;
}

function parseStrategyId(payload) {
  const id = Number(payload?.strategy?.id || payload?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function parseSystemId(payload) {
  const id = Number(payload?.system?.id || payload?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
}

function scoreSummary(summary) {
  const ret = Number(summary?.totalReturnPercent || 0);
  const pf = Number(summary?.profitFactor || 0);
  const wr = Number(summary?.winRatePercent || 0);
  const dd = Number(summary?.maxDrawdownPercent || 0);
  const trades = Number(summary?.tradesCount || 0);

  // Cap PF influence so tiny-sample outliers (e.g. PF=999 on 2-3 trades) do not dominate ranking.
  const pfClamped = Math.min(5, Math.max(0, pf));
  const tradeBoost = Math.min(200, Math.max(0, trades)) * 0.01;
  const lowTradesPenalty = trades < ROBUST_MIN_TRADES
    ? (ROBUST_MIN_TRADES - trades) * 0.05
    : 0;

  return ret + pfClamped * 12 + wr * 0.05 - dd * 0.8 + tradeBoost - lowTradesPenalty;
}

function robustPass(summary) {
  const pf = Number(summary?.profitFactor || 0);
  const dd = Number(summary?.maxDrawdownPercent || 0);
  const trades = Number(summary?.tradesCount || 0);
  const ret = Number(summary?.totalReturnPercent || 0);

  return pf >= ROBUST_MIN_PF && dd <= ROBUST_MAX_DD && trades >= ROBUST_MIN_TRADES && ret > 0;
}

function discoverLatestSweepFile() {
  if (SWEEP_FILE) {
    const explicitPath = path.resolve(process.cwd(), SWEEP_FILE);
    return fs.existsSync(explicitPath) ? explicitPath : null;
  }

  const dir = path.resolve(process.cwd(), 'backend/logs/backtests');
  if (!fs.existsSync(dir)) {
    return null;
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => /^third_strategy_sweep_.*\.json$/i.test(name))
    .map((name) => ({
      fullPath: path.join(dir, name),
      mtimeMs: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  return files.length > 0 ? files[0].fullPath : null;
}

function pickUniqueByMarket(rows, mode, takeCount) {
  const picked = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const market = String(row?.market || '').toUpperCase();
    if (!market || seen.has(market)) {
      continue;
    }

    if (mode === 'synth' && !market.includes('/')) {
      continue;
    }

    if (mode === 'mono' && market.includes('/')) {
      continue;
    }

    seen.add(market);
    picked.push(market);

    if (picked.length >= takeCount) {
      break;
    }
  }

  return picked;
}

function buildUniverse() {
  const sweepPath = discoverLatestSweepFile();

  let sweepSynth = [];
  let sweepMono = [];

  if (sweepPath && fs.existsSync(sweepPath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(sweepPath, 'utf-8'));
      sweepSynth = pickUniqueByMarket(raw?.topScoreSynth, 'synth', TOP_SYNTH_UNIVERSE);
      sweepMono = pickUniqueByMarket(raw?.topScoreMono, 'mono', TOP_MONO_UNIVERSE);
    } catch (error) {
      console.log(`[WARN] Failed to parse sweep file ${sweepPath}: ${error?.message || error}`);
    }
  }

  const synthSet = new Set([...sweepSynth, ...ADDITIONAL_SYNTH, ...FALLBACK_SYNTH].map((item) => item.toUpperCase()));
  const monoSet = new Set([...sweepMono, ...ADDITIONAL_MONO, ...FALLBACK_MONO].map((item) => item.toUpperCase()));

  const synthMarkets = [...synthSet]
    .filter((item) => item.includes('/'))
    .slice(0, Math.max(TOP_SYNTH_UNIVERSE, 6));

  const monoMarkets = [...monoSet]
    .filter((item) => !item.includes('/'))
    .slice(0, Math.max(TOP_MONO_UNIVERSE, 6));

  return {
    sweepPath,
    synthMarkets,
    monoMarkets,
  };
}

function parseMarket(market) {
  const normalized = String(market || '').toUpperCase();
  if (normalized.includes('/')) {
    const [base, quote] = normalized.split('/').map((item) => String(item || '').trim());
    if (!base || !quote) {
      return null;
    }
    return {
      mode: 'synth',
      market: normalized,
      baseSymbol: base,
      quoteSymbol: quote,
    };
  }

  if (!normalized) {
    return null;
  }

  return {
    mode: 'mono',
    market: normalized,
    baseSymbol: normalized,
    quoteSymbol: '',
  };
}

function sampleEvenly(items, maxCount) {
  if (!Array.isArray(items) || items.length <= maxCount) {
    return Array.isArray(items) ? [...items] : [];
  }

  if (maxCount <= 1) {
    return [items[0]];
  }

  const out = [];
  const step = (items.length - 1) / (maxCount - 1);

  for (let i = 0; i < maxCount; i += 1) {
    const idx = Math.min(items.length - 1, Math.round(i * step));
    out.push(items[idx]);
  }

  return out;
}

function buildDonchianVariants(marketInfo, strategyType) {
  const variants = [];

  for (const length of DONCH_LEN_GRID) {
    if (!Number.isFinite(length) || length < 2) continue;

    for (const takeProfitPercent of DONCH_TP_GRID) {
      if (!Number.isFinite(takeProfitPercent) || takeProfitPercent < 0) continue;

      for (const detectionSource of DONCH_SRC_GRID) {
        variants.push({
          marketInfo,
          strategyType,
          interval: INTERVAL,
          length: Math.floor(length),
          takeProfitPercent,
          detectionSource,
          zscoreEntry: 2,
          zscoreExit: 0.5,
          zscoreStop: 3.5,
        });
      }
    }
  }

  return EXHAUSTIVE_MODE
    ? variants
    : sampleEvenly(variants, MAX_VARIANTS_PER_MARKET_TYPE);
}

function buildStatArbVariants(marketInfo) {
  const variants = [];

  for (const length of STAT_LEN_GRID) {
    if (!Number.isFinite(length) || length < 2) continue;

    for (const zscoreEntry of STAT_ENTRY_GRID) {
      if (!Number.isFinite(zscoreEntry) || zscoreEntry <= 0) continue;

      for (const zscoreExit of STAT_EXIT_GRID) {
        if (!Number.isFinite(zscoreExit) || zscoreExit < 0 || zscoreExit >= zscoreEntry) continue;

        for (const zscoreStop of STAT_STOP_GRID) {
          if (!Number.isFinite(zscoreStop) || zscoreStop <= zscoreEntry) continue;

          variants.push({
            marketInfo,
            strategyType: 'stat_arb_zscore',
            interval: INTERVAL,
            length: Math.floor(length),
            takeProfitPercent: 0,
            detectionSource: 'close',
            zscoreEntry,
            zscoreExit,
            zscoreStop,
          });
        }
      }
    }
  }

  return EXHAUSTIVE_MODE
    ? variants
    : sampleEvenly(variants, MAX_VARIANTS_PER_MARKET_TYPE);
}

function buildVariantBuckets(marketInfos) {
  const buckets = [];

  for (const marketInfo of marketInfos) {
    for (const strategyType of STRATEGY_TYPES) {
      let variants = [];

      if (strategyType === 'stat_arb_zscore') {
        variants = buildStatArbVariants(marketInfo);
      } else {
        variants = buildDonchianVariants(marketInfo, strategyType);
      }

      if (variants.length > 0) {
        buckets.push(variants);
      }
    }
  }

  return buckets;
}

function roundRobinPick(buckets, maxCount) {
  const pointers = buckets.map(() => 0);
  const picked = [];

  while (picked.length < maxCount) {
    let progressed = false;

    for (let i = 0; i < buckets.length; i += 1) {
      if (picked.length >= maxCount) break;

      const bucket = buckets[i];
      const ptr = pointers[i];
      if (ptr >= bucket.length) {
        continue;
      }

      picked.push(bucket[ptr]);
      pointers[i] += 1;
      progressed = true;
    }

    if (!progressed) {
      break;
    }
  }

  return picked;
}

function strategyTypeTag(strategyType) {
  if (strategyType === 'stat_arb_zscore') return 'SZ';
  if (strategyType === 'zz_breakout') return 'ZZ';
  return 'DD';
}

function buildStrategyName(variant) {
  const modeTag = variant.marketInfo.mode === 'synth' ? 'S' : 'M';
  const marketTag = variant.marketInfo.market.replace('/', '_');
  const typeTag = strategyTypeTag(variant.strategyType);

  if (variant.strategyType === 'stat_arb_zscore') {
    return [
      STRATEGY_PREFIX,
      typeTag,
      modeTag,
      marketTag,
      variant.interval,
      `L${variant.length}`,
      `ZE${variant.zscoreEntry}`,
      `ZX${variant.zscoreExit}`,
      `ZS${variant.zscoreStop}`,
    ].join('_');
  }

  return [
    STRATEGY_PREFIX,
    typeTag,
    modeTag,
    marketTag,
    variant.interval,
    `L${variant.length}`,
    `TP${variant.takeProfitPercent}`,
    `SRC${variant.detectionSource}`,
  ].join('_');
}

function buildStrategyPayload(name, variant) {
  return {
    name,
    strategy_type: variant.strategyType,
    market_mode: variant.marketInfo.mode === 'synth' ? 'synthetic' : 'mono',
    base_symbol: variant.marketInfo.baseSymbol,
    quote_symbol: variant.marketInfo.quoteSymbol,
    interval: variant.interval,
    price_channel_length: variant.length,
    take_profit_percent: variant.takeProfitPercent,
    detection_source: variant.detectionSource,
    zscore_entry: variant.zscoreEntry,
    zscore_exit: variant.zscoreExit,
    zscore_stop: variant.zscoreStop,
    long_enabled: true,
    short_enabled: true,
    lot_long_percent: 10,
    lot_short_percent: 10,
    leverage: 20,
    fixed_lot: false,
    base_coef: 1,
    quote_coef: variant.marketInfo.mode === 'synth' ? 1 : 0,
    is_active: false,
  };
}

async function ensureStrategy(existingByName, variant) {
  const name = buildStrategyName(variant);
  const payload = buildStrategyPayload(name, variant);

  const existingId = Number(existingByName.get(name) || 0);
  if (existingId > 0) {
    await api('PUT', `/strategies/${API_KEY_NAME}/${existingId}`, payload);
    return {
      strategyId: existingId,
      strategyName: name,
      created: false,
      variant,
    };
  }

  const created = await api('POST', `/strategies/${API_KEY_NAME}`, payload);
  const createdId = parseStrategyId(created);
  if (!createdId) {
    throw new Error(`Failed to create strategy ${name}`);
  }

  existingByName.set(name, createdId);

  return {
    strategyId: createdId,
    strategyName: name,
    created: true,
    variant,
  };
}

async function runSingleBacktest(strategyId) {
  const payload = await api('POST', '/backtest/run', {
    apiKeyName: API_KEY_NAME,
    mode: 'single',
    strategyId,
    bars: BACKTEST_BARS,
    dateFrom: DATE_FROM,
    dateTo: DATE_TO || undefined,
    warmupBars: WARMUP_BARS,
    skipMissingSymbols: SKIP_MISSING_SYMBOLS,
    initialBalance: INITIAL_BALANCE,
    commissionPercent: COMMISSION,
    slippagePercent: SLIPPAGE,
    fundingRatePercent: FUNDING,
    saveResult: false,
  });

  return payload?.result?.summary || {};
}

function toRecord(ensured, summary) {
  return {
    strategyId: ensured.strategyId,
    strategyName: ensured.strategyName,
    created: ensured.created,
    strategyType: ensured.variant.strategyType,
    marketMode: ensured.variant.marketInfo.mode,
    market: ensured.variant.marketInfo.market,
    interval: ensured.variant.interval,
    length: ensured.variant.length,
    takeProfitPercent: ensured.variant.takeProfitPercent,
    detectionSource: ensured.variant.detectionSource,
    zscoreEntry: ensured.variant.zscoreEntry,
    zscoreExit: ensured.variant.zscoreExit,
    zscoreStop: ensured.variant.zscoreStop,
    finalEquity: Number(summary?.finalEquity || 0),
    totalReturnPercent: Number(summary?.totalReturnPercent || 0),
    maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
    winRatePercent: Number(summary?.winRatePercent || 0),
    profitFactor: Number(summary?.profitFactor || 0),
    tradesCount: Number(summary?.tradesCount || 0),
    score: scoreSummary(summary),
    robust: robustPass(summary),
  };
}

function topRows(rows, maxRows = 10) {
  return [...rows].sort((a, b) => b.score - a.score).slice(0, maxRows);
}

function selectMembers(records) {
  const robust = records.filter((item) => item.robust);
  const pool = (robust.length > 0 ? robust : records).slice().sort((a, b) => b.score - a.score);

  const selected = [];
  const usedIds = new Set();
  const usedMarkets = new Set();

  const add = (item, allowDuplicateMarket = ALLOW_DUPLICATE_MARKETS) => {
    if (!item || usedIds.has(item.strategyId) || selected.length >= MAX_MEMBERS) {
      return;
    }

    if (!allowDuplicateMarket && usedMarkets.has(item.market)) {
      return;
    }

    usedIds.add(item.strategyId);
    usedMarkets.add(item.market);
    selected.push(item);
  };

  for (const strategyType of STRATEGY_TYPES) {
    add(pool.find((item) => item.strategyType === strategyType));
  }

  add(pool.find((item) => item.marketMode === 'synth'));
  add(pool.find((item) => item.marketMode === 'mono'));

  for (const item of pool) {
    add(item);
  }

  // If strict uniqueness starves member count, relax market uniqueness as fallback.
  if (!ALLOW_DUPLICATE_MARKETS && selected.length < Math.min(MAX_MEMBERS, 3)) {
    for (const item of pool) {
      add(item, true);
      if (selected.length >= Math.min(MAX_MEMBERS, 3)) {
        break;
      }
    }
  }

  return selected.slice(0, MAX_MEMBERS);
}

async function ensureSystem(members) {
  const systemsPayload = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const systems = Array.isArray(systemsPayload) ? systemsPayload : [];
  const existing = systems.find((item) => String(item?.name || '') === SYSTEM_NAME);

  if (!existing?.id) {
    const created = await api('POST', `/trading-systems/${API_KEY_NAME}`, {
      name: SYSTEM_NAME,
      description: `Historical sweep candidate from ${DATE_FROM}${DATE_TO ? ` to ${DATE_TO}` : ''}`,
      auto_sync_members: false,
      discovery_enabled: false,
      discovery_interval_hours: 6,
      max_members: Math.max(MAX_MEMBERS, 8),
      members,
    });

    const createdId = parseSystemId(created);
    if (!createdId) {
      throw new Error('Failed to create historical sweep trading system');
    }

    return createdId;
  }

  const systemId = Number(existing.id);

  await api('PUT', `/trading-systems/${API_KEY_NAME}/${systemId}`, {
    description: `Historical sweep candidate from ${DATE_FROM}${DATE_TO ? ` to ${DATE_TO}` : ''}`,
    auto_sync_members: false,
    discovery_enabled: false,
    discovery_interval_hours: 6,
    max_members: Math.max(MAX_MEMBERS, 8),
  });

  await api('PUT', `/trading-systems/${API_KEY_NAME}/${systemId}/members`, {
    members,
  });

  return systemId;
}

async function runPortfolioBacktest(systemId, dateFrom, dateTo, label) {
  const payload = await api('POST', `/trading-systems/${API_KEY_NAME}/${systemId}/backtest`, {
    bars: BACKTEST_BARS,
    dateFrom,
    dateTo: dateTo || undefined,
    warmupBars: WARMUP_BARS,
    skipMissingSymbols: SKIP_MISSING_SYMBOLS,
    initialBalance: INITIAL_BALANCE,
    commissionPercent: COMMISSION,
    slippagePercent: SLIPPAGE,
    fundingRatePercent: FUNDING,
    saveResult: false,
  });

  const summary = payload?.result?.summary || {};
  return {
    label,
    dateFrom,
    dateTo: dateTo || null,
    finalEquity: Number(summary?.finalEquity || 0),
    totalReturnPercent: Number(summary?.totalReturnPercent || 0),
    maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
    winRatePercent: Number(summary?.winRatePercent || 0),
    profitFactor: Number(summary?.profitFactor || 0),
    tradesCount: Number(summary?.tradesCount || 0),
  };
}

function isoDaysAgo(baseDate, days) {
  const ms = Number(baseDate.getTime()) - days * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

function buildWindowRequests() {
  const windows = [];
  const end = DATE_TO ? new Date(DATE_TO) : new Date();
  const startFloor = new Date(DATE_FROM);

  for (const days of PORTFOLIO_WINDOWS_DAYS) {
    const from = new Date(isoDaysAgo(end, days));
    if (!Number.isFinite(from.getTime())) continue;
    if (from <= startFloor) continue;

    windows.push({
      label: `last_${days}d`,
      dateFrom: from.toISOString(),
      dateTo: DATE_TO || end.toISOString(),
    });
  }

  return windows;
}

async function main() {
  const startedAt = Date.now();

  console.log(`[START] Historical system sweep for ${API_KEY_NAME}`);
  console.log(`[RANGE] ${DATE_FROM} -> ${DATE_TO || 'now'}`);
  console.log(
    `[SETUP] interval=${INTERVAL}, mode=${EXHAUSTIVE_MODE ? 'exhaustive' : 'sampled'}, maxRuns=${MAX_RUNS}, maxVariantsPerMarketType=${MAX_VARIANTS_PER_MARKET_TYPE}`
  );
  console.log(`[SETUP] strategyTypes=${STRATEGY_TYPES.join(', ')}`);

  if (STRATEGY_TYPES.length === 0) {
    throw new Error('No strategy types selected');
  }

  const universe = buildUniverse();
  const marketInfos = [
    ...universe.synthMarkets.map(parseMarket),
    ...universe.monoMarkets.map(parseMarket),
  ].filter(Boolean);

  if (marketInfos.length === 0) {
    throw new Error('No markets in universe');
  }

  console.log(
    `[UNIVERSE] synth=${universe.synthMarkets.length}, mono=${universe.monoMarkets.length}, total=${marketInfos.length}`
  );
  if (universe.sweepPath) {
    console.log(`[UNIVERSE] sweepFile=${universe.sweepPath}`);
  }

  const buckets = buildVariantBuckets(marketInfos);
  const potentialRuns = buckets.reduce((sum, bucket) => sum + bucket.length, 0);
  const runLimit = EXHAUSTIVE_MODE
    ? (MAX_RUNS > 0 ? MAX_RUNS : potentialRuns)
    : (MAX_RUNS > 0 ? Math.max(10, MAX_RUNS) : 240);
  const runPlan = roundRobinPick(buckets, runLimit);
  const coveragePercent = potentialRuns > 0
    ? Number(((runPlan.length / potentialRuns) * 100).toFixed(2))
    : 0;

  console.log(
    `[PLAN] buckets=${buckets.length}, potentialRuns=${potentialRuns}, scheduledRuns=${runPlan.length}, coverage=${coveragePercent}%`
  );

  const strategies = await api('GET', `/strategies/${API_KEY_NAME}`);
  const existingByName = new Map(
    (Array.isArray(strategies) ? strategies : []).map((item) => [String(item?.name || ''), Number(item?.id || 0)])
  );

  const evaluated = [];
  const failures = [];

  for (let i = 0; i < runPlan.length; i += 1) {
    const variant = runPlan[i];
    const runLabel = `${i + 1}/${runPlan.length}`;

    try {
      const ensured = await ensureStrategy(existingByName, variant);
      const summary = await runSingleBacktest(ensured.strategyId);
      const record = toRecord(ensured, summary);
      evaluated.push(record);

      console.log(
        `[RUN ${runLabel}] ${record.strategyType} ${record.marketMode} ${record.market} L${record.length} RET=${record.totalReturnPercent.toFixed(2)} PF=${record.profitFactor.toFixed(2)} DD=${record.maxDrawdownPercent.toFixed(2)} WR=${record.winRatePercent.toFixed(2)} T=${record.tradesCount} SCORE=${record.score.toFixed(2)}${record.robust ? ' [ROBUST]' : ''}`
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failures.push({
        index: i,
        variant,
        error: message,
      });
      console.log(`[FAIL ${runLabel}] ${variant.strategyType} ${variant.marketInfo.market}: ${message}`);
    }
  }

  if (evaluated.length === 0) {
    throw new Error(`No successful backtests. Failures: ${failures.length}`);
  }

  const selected = selectMembers(evaluated);
  if (selected.length === 0) {
    throw new Error('No selected members after evaluation');
  }

  const members = selected.map((item, index) => ({
    strategy_id: item.strategyId,
    weight: index === 0 ? 1.25 : index === 1 ? 1.1 : 1.0,
    member_role: index < 3 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `historical_sweep ${item.strategyType} ${item.market}`,
  }));

  const systemId = await ensureSystem(members);

  const portfolioResults = [];
  portfolioResults.push(await runPortfolioBacktest(systemId, DATE_FROM, DATE_TO, 'full_range'));

  const windows = buildWindowRequests();
  for (const windowRequest of windows) {
    try {
      const result = await runPortfolioBacktest(
        systemId,
        windowRequest.dateFrom,
        windowRequest.dateTo,
        windowRequest.label
      );
      portfolioResults.push(result);
    } catch (error) {
      portfolioResults.push({
        label: windowRequest.label,
        dateFrom: windowRequest.dateFrom,
        dateTo: windowRequest.dateTo,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const topAll = topRows(evaluated, 25);
  const topByType = {
    DD_BattleToads: topRows(evaluated.filter((item) => item.strategyType === 'DD_BattleToads'), 10),
    stat_arb_zscore: topRows(evaluated.filter((item) => item.strategyType === 'stat_arb_zscore'), 10),
    zz_breakout: topRows(evaluated.filter((item) => item.strategyType === 'zz_breakout'), 10),
  };
  const topByMode = {
    synth: topRows(evaluated.filter((item) => item.marketMode === 'synth'), 10),
    mono: topRows(evaluated.filter((item) => item.marketMode === 'mono'), 10),
  };

  const durationSec = Math.round((Date.now() - startedAt) / 1000);

  const output = {
    timestamp: nowIso(),
    apiKeyName: API_KEY_NAME,
    config: {
      dateFrom: DATE_FROM,
      dateTo: DATE_TO || null,
      interval: INTERVAL,
      backtestBars: BACKTEST_BARS,
      warmupBars: WARMUP_BARS,
      skipMissingSymbols: SKIP_MISSING_SYMBOLS,
      initialBalance: INITIAL_BALANCE,
      commissionPercent: COMMISSION,
      slippagePercent: SLIPPAGE,
      fundingRatePercent: FUNDING,
      maxRuns: MAX_RUNS,
      maxVariantsPerMarketType: MAX_VARIANTS_PER_MARKET_TYPE,
      exhaustiveMode: EXHAUSTIVE_MODE,
      allowDuplicateMarkets: ALLOW_DUPLICATE_MARKETS,
      maxMembers: MAX_MEMBERS,
      robust: {
        minProfitFactor: ROBUST_MIN_PF,
        maxDrawdownPercent: ROBUST_MAX_DD,
        minTrades: ROBUST_MIN_TRADES,
      },
      strategyTypes: STRATEGY_TYPES,
      systemName: SYSTEM_NAME,
      strategyPrefix: STRATEGY_PREFIX,
    },
    universe: {
      sweepFile: universe.sweepPath,
      synthMarkets: universe.synthMarkets,
      monoMarkets: universe.monoMarkets,
    },
    counts: {
      potentialRuns,
      scheduledRuns: runPlan.length,
      coveragePercent,
      evaluated: evaluated.length,
      failures: failures.length,
      robust: evaluated.filter((item) => item.robust).length,
      durationSec,
    },
    failures,
    topAll,
    topByType,
    topByMode,
    selectedMembers: selected,
    tradingSystem: {
      id: systemId,
      name: SYSTEM_NAME,
      members,
    },
    portfolioResults,
    evaluated,
  };

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_historical_sweep_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  const fullPortfolio = portfolioResults[0] || {};

  console.log('--- HISTORICAL SWEEP SUMMARY ---');
  console.log(
    `Runs: potential=${potentialRuns}, scheduled=${runPlan.length}, coverage=${coveragePercent}%, evaluated=${evaluated.length}, failures=${failures.length}`
  );
  console.log(`Robust candidates: ${evaluated.filter((item) => item.robust).length}`);
  console.log(`Selected members: ${selected.map((item) => `${item.market}:${item.strategyType}`).join(', ')}`);
  console.log(`System: ${SYSTEM_NAME} (id=${systemId})`);
  if (!fullPortfolio.error) {
    console.log(
      `Portfolio(full): RET=${Number(fullPortfolio.totalReturnPercent || 0).toFixed(2)} PF=${Number(fullPortfolio.profitFactor || 0).toFixed(2)} DD=${Number(fullPortfolio.maxDrawdownPercent || 0).toFixed(2)} WR=${Number(fullPortfolio.winRatePercent || 0).toFixed(2)} T=${Number(fullPortfolio.tradesCount || 0)}`
    );
  }
  console.log(`Saved: ${outFile}`);
}

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const API_KEY_NAME = process.env.API_KEY_NAME || 'BTDD_D1';
const API_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'defaultpassword';

const STRATEGY_PREFIX = process.env.STRATEGY_PREFIX || 'AB_DONCH';
const SYSTEM_NAME = process.env.SYSTEM_NAME || 'AB BTDD_D1 Mono Portfolio';

const CANDIDATES = [
  { symbol: 'STXUSDT', tier: 'C1', weight: 1.2 },
  { symbol: 'TRUUSDT', tier: 'C1', weight: 1.0 },
  { symbol: 'VETUSDT', tier: 'C1', weight: 0.8 },
  { symbol: 'GRTUSDT', tier: 'C4', weight: 1.0 },
  { symbol: 'INJUSDT', tier: 'C4', weight: 1.2 },
];

const BACKTEST = {
  bars: 336,
  initialBalance: 10000,
  commissionPercent: 0.1,
  slippagePercent: 0.05,
  fundingRatePercent: 0,
};

const OPT_GRID = {
  priceChannelLength: [30, 50, 70],
  takeProfitPercent: [5, 7.5, 10],
};

const headers = {
  Authorization: `Bearer ${AUTH_PASSWORD}`,
  'Content-Type': 'application/json',
};

const scoreSummary = (summary) => {
  const ret = Number(summary?.totalReturnPercent || 0);
  const pf = Number(summary?.profitFactor || 0);
  const wr = Number(summary?.winRatePercent || 0);
  const dd = Number(summary?.maxDrawdownPercent || 0);
  return ret + pf * 10 + wr * 0.05 - dd * 0.7;
};

const toRecord = (strategyId, strategyName, symbol, tier, priceChannelLength, takeProfitPercent, summary) => {
  return {
    strategyId,
    strategyName,
    symbol,
    tier,
    priceChannelLength,
    takeProfitPercent,
    trades: Number(summary?.tradesCount || 0),
    winRatePercent: Number(summary?.winRatePercent || 0),
    profitFactor: Number(summary?.profitFactor || 0),
    maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
    totalReturnPercent: Number(summary?.totalReturnPercent || 0),
    score: scoreSummary(summary),
  };
};

const api = async (method, route, body) => {
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
    } catch (error) {
      throw new Error(`${method} ${route} invalid JSON: ${text.slice(0, 300)}`);
    }
  }

  if (!res.ok) {
    const msg = payload?.error || `${res.status} ${res.statusText}`;
    throw new Error(`${method} ${route} failed: ${msg}`);
  }

  return payload;
};

const runSingleBacktest = async (strategyId) => {
  const payload = await api('POST', '/backtest/run', {
    apiKeyName: API_KEY_NAME,
    mode: 'single',
    strategyId,
    ...BACKTEST,
    saveResult: false,
  });

  return payload?.result?.summary || {};
};

const ensureCandidates = async () => {
  const existing = await api('GET', `/strategies/${API_KEY_NAME}`);
  const byName = new Map(
    (Array.isArray(existing) ? existing : []).map((s) => [String(s?.name || ''), Number(s?.id || 0)])
  );

  const idsBySymbol = new Map();

  for (const candidate of CANDIDATES) {
    const name = `${STRATEGY_PREFIX} ${candidate.symbol}`;
    const strategyPayload = {
      name,
      strategy_type: 'DD_BattleToads',
      market_mode: 'mono',
      base_symbol: candidate.symbol,
      quote_symbol: '',
      interval: '4h',
      price_channel_length: 50,
      take_profit_percent: 7.5,
      detection_source: 'close',
      long_enabled: true,
      short_enabled: true,
      lot_long_percent: 100,
      lot_short_percent: 100,
      leverage: 20,
      fixed_lot: false,
      is_active: false,
    };

    const existingId = byName.get(name);
    if (existingId && existingId > 0) {
      await api('PUT', `/strategies/${API_KEY_NAME}/${existingId}`, strategyPayload);
      idsBySymbol.set(candidate.symbol, existingId);
      console.log(`[SYNC] Updated strategy ${name} (id=${existingId})`);
      continue;
    }

    const created = await api('POST', `/strategies/${API_KEY_NAME}`, strategyPayload);
    const createdId = Number(created?.strategy?.id || 0);
    if (!createdId) {
      throw new Error(`Failed to create strategy ${name}`);
    }

    idsBySymbol.set(candidate.symbol, createdId);
    console.log(`[SYNC] Created strategy ${name} (id=${createdId})`);
  }

  return idsBySymbol;
};

const ensureTradingSystem = async (members) => {
  const systems = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const list = Array.isArray(systems) ? systems : [];
  const existing = list.find((s) => String(s?.name || '') === SYSTEM_NAME);

  if (!existing || !existing.id) {
    const created = await api('POST', `/trading-systems/${API_KEY_NAME}`, {
      name: SYSTEM_NAME,
      description: 'A+B: optimized mono donchian basket',
      auto_sync_members: true,
      discovery_enabled: false,
      max_members: 8,
      members,
    });

    const systemId = Number(created?.system?.id || 0);
    if (!systemId) {
      throw new Error('Trading system create failed');
    }

    console.log(`[SYSTEM] Created system ${SYSTEM_NAME} (id=${systemId})`);
    return systemId;
  }

  const systemId = Number(existing.id);
  await api('PUT', `/trading-systems/${API_KEY_NAME}/${systemId}`, {
    description: 'A+B: optimized mono donchian basket',
    auto_sync_members: true,
    discovery_enabled: false,
    max_members: 8,
  });

  await api('PUT', `/trading-systems/${API_KEY_NAME}/${systemId}/members`, { members });
  console.log(`[SYSTEM] Updated system ${SYSTEM_NAME} (id=${systemId})`);
  return systemId;
};

const main = async () => {
  console.log(`[START] API=${API_BASE_URL}, key=${API_KEY_NAME}`);

  const idsBySymbol = await ensureCandidates();

  const baseline = [];
  for (const candidate of CANDIDATES) {
    const strategyId = Number(idsBySymbol.get(candidate.symbol));
    const strategyName = `${STRATEGY_PREFIX} ${candidate.symbol}`;
    const summary = await runSingleBacktest(strategyId);
    const record = toRecord(strategyId, strategyName, candidate.symbol, candidate.tier, 50, 7.5, summary);
    baseline.push(record);
    console.log(
      `[BASE] ${candidate.symbol}: WR=${record.winRatePercent.toFixed(2)} PF=${record.profitFactor.toFixed(2)} DD=${record.maxDrawdownPercent.toFixed(2)} RET=${record.totalReturnPercent.toFixed(2)} SCORE=${record.score.toFixed(2)}`
    );
  }

  const baselineTop = [...baseline].sort((a, b) => b.score - a.score).slice(0, 3);

  const optimized = [];
  for (const base of baselineTop) {
    let best = base;

    for (const pclen of OPT_GRID.priceChannelLength) {
      for (const tp of OPT_GRID.takeProfitPercent) {
        await api('PUT', `/strategies/${API_KEY_NAME}/${base.strategyId}`, {
          price_channel_length: pclen,
          take_profit_percent: tp,
          is_active: false,
        });

        const summary = await runSingleBacktest(base.strategyId);
        const record = toRecord(
          base.strategyId,
          base.strategyName,
          base.symbol,
          base.tier,
          pclen,
          tp,
          summary
        );

        if (record.score > best.score) {
          best = record;
        }
      }
    }

    await api('PUT', `/strategies/${API_KEY_NAME}/${base.strategyId}`, {
      price_channel_length: best.priceChannelLength,
      take_profit_percent: best.takeProfitPercent,
      is_active: false,
    });

    optimized.push(best);
    console.log(
      `[OPT] ${best.symbol}: len=${best.priceChannelLength}, tp=${best.takeProfitPercent}, WR=${best.winRatePercent.toFixed(2)} PF=${best.profitFactor.toFixed(2)} DD=${best.maxDrawdownPercent.toFixed(2)} RET=${best.totalReturnPercent.toFixed(2)} SCORE=${best.score.toFixed(2)}`
    );
  }

  const selectedSymbols = new Set(optimized.map((x) => x.symbol));
  const members = CANDIDATES
    .filter((candidate) => selectedSymbols.has(candidate.symbol))
    .map((candidate) => {
      const strategyId = Number(idsBySymbol.get(candidate.symbol));
      return {
        strategy_id: strategyId,
        weight: candidate.weight,
        member_role: candidate.weight >= 1 ? 'core' : 'satellite',
        is_enabled: true,
        notes: `A+B selected (${candidate.tier})`,
      };
    });

  const systemId = await ensureTradingSystem(members);
  await api('POST', `/trading-systems/${API_KEY_NAME}/${systemId}/activation`, {
    isActive: true,
    syncMembers: true,
  });

  const portfolioRun = await api('POST', `/trading-systems/${API_KEY_NAME}/${systemId}/backtest`, {
    ...BACKTEST,
    saveResult: false,
  });

  const portfolioSummary = portfolioRun?.result?.summary || {};

  const output = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    baseline,
    baselineTop,
    optimized,
    selectedSymbols: [...selectedSymbols],
    systemId,
    portfolioSummary,
  };

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_ab_results.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('--- FINAL ---');
  console.log(`Selected symbols: ${[...selectedSymbols].join(', ')}`);
  console.log(
    `Portfolio: RET=${Number(portfolioSummary.totalReturnPercent || 0).toFixed(2)} PF=${Number(portfolioSummary.profitFactor || 0).toFixed(2)} DD=${Number(portfolioSummary.maxDrawdownPercent || 0).toFixed(2)} WR=${Number(portfolioSummary.winRatePercent || 0).toFixed(2)} trades=${Number(portfolioSummary.tradesCount || 0)}`
  );
  console.log(`Saved results: ${outFile}`);
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

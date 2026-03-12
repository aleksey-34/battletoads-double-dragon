#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const API_KEY_NAME = process.env.API_KEY_NAME || 'BTDD_D1';
const API_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'defaultpassword';
const SYMBOL = String(process.env.SYMBOL || 'TRUUSDT').toUpperCase();
const APPLY_BEST = String(process.env.APPLY_BEST || '0').trim() === '1';

const BARS = Math.max(120, Number(process.env.BARS || 336));
const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 10000);
const COMMISSION = Number(process.env.COMMISSION || 0.1);
const SLIPPAGE = Number(process.env.SLIPPAGE || 0.05);
const FUNDING = Number(process.env.FUNDING || 0);

const LEN_GRID = String(process.env.LEN_GRID || '30,40,50,60,70,90,120')
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item >= 2);

const TP_GRID = String(process.env.TP_GRID || '3,5,7.5,10,12')
  .split(',')
  .map((item) => Number(item.trim()))
  .filter((item) => Number.isFinite(item) && item > 0);

const DETECTION_GRID = String(process.env.DETECTION_GRID || 'close,wick')
  .split(',')
  .map((item) => item.trim().toLowerCase())
  .filter((item) => item === 'close' || item === 'wick');

const headers = {
  Authorization: `Bearer ${AUTH_PASSWORD}`,
  'Content-Type': 'application/json',
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

const scoreSummary = (summary) => {
  const ret = Number(summary?.totalReturnPercent || 0);
  const pf = Number(summary?.profitFactor || 0);
  const wr = Number(summary?.winRatePercent || 0);
  const dd = Number(summary?.maxDrawdownPercent || 0);
  return ret + pf * 10 + wr * 0.05 - dd * 0.7;
};

const runSingleBacktest = async (strategyId) => {
  const payload = await api('POST', '/backtest/run', {
    apiKeyName: API_KEY_NAME,
    mode: 'single',
    strategyId,
    bars: BARS,
    initialBalance: INITIAL_BALANCE,
    commissionPercent: COMMISSION,
    slippagePercent: SLIPPAGE,
    fundingRatePercent: FUNDING,
    saveResult: false,
  });

  return payload?.result?.summary || {};
};

const main = async () => {
  console.log(`[START] Reopt symbol ${SYMBOL} on ${API_KEY_NAME}`);

  const strategies = await api('GET', `/strategies/${API_KEY_NAME}`);
  const strategyList = Array.isArray(strategies) ? strategies : [];

  const target = strategyList.find((item) => {
    const base = String(item?.base_symbol || '').toUpperCase();
    const name = String(item?.name || '').toUpperCase();
    return base === SYMBOL || name.includes(SYMBOL);
  });

  if (!target?.id) {
    throw new Error(`Strategy for symbol ${SYMBOL} not found on ${API_KEY_NAME}`);
  }

  const strategyId = Number(target.id);
  console.log(`[TARGET] ${target.name} (id=${strategyId})`);

  await api('PUT', `/strategies/${API_KEY_NAME}/${strategyId}`, {
    is_active: false,
  });

  const variants = [];

  for (const length of LEN_GRID) {
    for (const tp of TP_GRID) {
      for (const detection of DETECTION_GRID) {
        await api('PUT', `/strategies/${API_KEY_NAME}/${strategyId}`, {
          price_channel_length: length,
          take_profit_percent: tp,
          detection_source: detection,
          is_active: false,
        });

        const summary = await runSingleBacktest(strategyId);
        const record = {
          symbol: SYMBOL,
          strategyId,
          length,
          takeProfitPercent: tp,
          detectionSource: detection,
          trades: Number(summary?.tradesCount || 0),
          winRatePercent: Number(summary?.winRatePercent || 0),
          profitFactor: Number(summary?.profitFactor || 0),
          maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
          totalReturnPercent: Number(summary?.totalReturnPercent || 0),
          score: scoreSummary(summary),
        };

        variants.push(record);
      }
    }
  }

  variants.sort((a, b) => b.score - a.score);
  const top = variants.slice(0, 10);
  const best = top[0];

  if (!best) {
    throw new Error('No reoptimization results generated');
  }

  if (APPLY_BEST) {
    await api('PUT', `/strategies/${API_KEY_NAME}/${strategyId}`, {
      price_channel_length: best.length,
      take_profit_percent: best.takeProfitPercent,
      detection_source: best.detectionSource,
      is_active: false,
      last_action: 'reoptimized_candidate',
      last_error: null,
    });
    console.log(`[APPLY] Applied best params to paused strategy id=${strategyId}`);
  }

  const profitable = variants.filter((item) => item.totalReturnPercent > 0).length;
  const robust = variants.filter((item) => item.profitFactor >= 1 && item.maxDrawdownPercent <= 12).length;

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_${SYMBOL.toLowerCase()}_reopt_${stamp}.json`);

  const payload = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    symbol: SYMBOL,
    strategyId,
    grid: {
      lengths: LEN_GRID,
      takeProfitPercent: TP_GRID,
      detectionSource: DETECTION_GRID,
    },
    applyBest: APPLY_BEST,
    best,
    top,
    totalVariants: variants.length,
    profitableVariants: profitable,
    robustVariants: robust,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));

  console.log('--- REOPT SUMMARY ---');
  console.log(`Variants: ${variants.length}`);
  console.log(`Profitable variants: ${profitable}`);
  console.log(`Robust variants (PF>=1, DD<=12): ${robust}`);
  console.log(`Best: len=${best.length}, tp=${best.takeProfitPercent}, src=${best.detectionSource}, WR=${best.winRatePercent.toFixed(2)}, PF=${best.profitFactor.toFixed(2)}, DD=${best.maxDrawdownPercent.toFixed(2)}, RET=${best.totalReturnPercent.toFixed(2)}, SCORE=${best.score.toFixed(2)}`);
  console.log(`Saved: ${outFile}`);
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

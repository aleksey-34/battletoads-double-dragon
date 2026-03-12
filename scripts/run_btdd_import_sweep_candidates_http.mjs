#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const API_KEY_NAME = process.env.API_KEY_NAME || 'BTDD_D1';
const API_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'defaultpassword';

const TOP_SYNTH = Math.max(0, Number(process.env.TOP_SYNTH || 3));
const TOP_MONO = Math.max(0, Number(process.env.TOP_MONO || 3));
const MAX_MEMBERS = Math.max(1, Number(process.env.MAX_MEMBERS || 4));
const ACTIVATE_SYSTEM = String(process.env.ACTIVATE_SYSTEM || '0').trim() === '1';

const SYSTEM_NAME = process.env.SYSTEM_NAME || `SWEEP ${API_KEY_NAME} Candidate Portfolio`;
const STRATEGY_PREFIX = process.env.STRATEGY_PREFIX || 'SWEEP_DONCH';

const BARS = Math.max(120, Number(process.env.BARS || 336));
const INITIAL_BALANCE = Number(process.env.INITIAL_BALANCE || 10000);
const COMMISSION = Number(process.env.COMMISSION || 0.1);
const SLIPPAGE = Number(process.env.SLIPPAGE || 0.05);
const FUNDING = Number(process.env.FUNDING || 0);

const SWEEP_FILE = process.env.SWEEP_FILE || '';

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

const parseStrategyIdFromPayload = (payload) => {
  const id = Number(payload?.strategy?.id || payload?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
};

const parseSystemIdFromPayload = (payload) => {
  const id = Number(payload?.system?.id || payload?.id || 0);
  return Number.isFinite(id) && id > 0 ? id : 0;
};

const discoverLatestSweepFile = () => {
  const dir = path.resolve(process.cwd(), 'backend/logs/backtests');
  if (!fs.existsSync(dir)) {
    throw new Error(`Sweep directory not found: ${dir}`);
  }

  const files = fs
    .readdirSync(dir)
    .filter((name) => /^third_strategy_sweep_.*\.json$/i.test(name))
    .map((name) => ({
      name,
      fullPath: path.join(dir, name),
      mtime: fs.statSync(path.join(dir, name)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);

  if (files.length === 0) {
    throw new Error(`No third_strategy_sweep JSON files in ${dir}`);
  }

  return files[0].fullPath;
};

const normalizeCandidate = (item, mode) => {
  const market = String(item?.market || '').toUpperCase();
  const tf = String(item?.tf || '4h');
  const len = Number(item?.len || 50);
  const tp = Number(item?.tp || 7.5);
  const risk = Number(item?.risk || 10);

  if (!market) {
    return null;
  }

  if (mode === 'synth') {
    const [base, quote] = market.split('/').map((s) => String(s || '').trim());
    if (!base || !quote) {
      return null;
    }

    return {
      mode: 'synth',
      market,
      base_symbol: base,
      quote_symbol: quote,
      tf,
      len,
      tp,
      risk,
      sweepScore: Number(item?.score || 0),
      sweepRet: Number(item?.ret || 0),
      sweepPf: Number(item?.pf || 0),
      sweepDd: Number(item?.dd || 0),
      sweepTrades: Number(item?.trades || 0),
    };
  }

  return {
    mode: 'mono',
    market,
    base_symbol: market,
    quote_symbol: '',
    tf,
    len,
    tp,
    risk,
    sweepScore: Number(item?.score || 0),
    sweepRet: Number(item?.ret || 0),
    sweepPf: Number(item?.pf || 0),
    sweepDd: Number(item?.dd || 0),
    sweepTrades: Number(item?.trades || 0),
  };
};

const pickUniqueByMarket = (rows, mode, takeCount) => {
  const picked = [];
  const seen = new Set();

  for (const row of Array.isArray(rows) ? rows : []) {
    const candidate = normalizeCandidate(row, mode);
    if (!candidate) {
      continue;
    }

    const key = candidate.market;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    picked.push(candidate);

    if (picked.length >= takeCount) {
      break;
    }
  }

  return picked;
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

const ensureStrategy = async (existingByName, candidate) => {
  const name = `${STRATEGY_PREFIX} ${candidate.market} ${candidate.tf} L${candidate.len} TP${candidate.tp} R${candidate.risk}`;

  const payload = {
    name,
    strategy_type: 'DD_BattleToads',
    market_mode: candidate.mode === 'synth' ? 'synthetic' : 'mono',
    base_symbol: candidate.base_symbol,
    quote_symbol: candidate.quote_symbol,
    interval: candidate.tf,
    price_channel_length: candidate.len,
    take_profit_percent: candidate.tp,
    detection_source: 'close',
    long_enabled: true,
    short_enabled: true,
    lot_long_percent: candidate.risk,
    lot_short_percent: candidate.risk,
    leverage: 20,
    fixed_lot: false,
    base_coef: 1,
    quote_coef: candidate.mode === 'synth' ? 1 : 0,
    is_active: false,
  };

  const existingId = Number(existingByName.get(name) || 0);
  if (existingId > 0) {
    await api('PUT', `/strategies/${API_KEY_NAME}/${existingId}`, payload);
    return { id: existingId, name, created: false };
  }

  const created = await api('POST', `/strategies/${API_KEY_NAME}`, payload);
  const createdId = parseStrategyIdFromPayload(created);

  if (!createdId) {
    throw new Error(`Failed to create strategy ${name}`);
  }

  return { id: createdId, name, created: true };
};

const ensureSystem = async (members) => {
  const systems = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const list = Array.isArray(systems) ? systems : [];
  const existing = list.find((item) => String(item?.name || '') === SYSTEM_NAME);

  if (!existing?.id) {
    const created = await api('POST', `/trading-systems/${API_KEY_NAME}`, {
      name: SYSTEM_NAME,
      description: 'Candidate portfolio built from third strategy sweep top markets',
      auto_sync_members: true,
      discovery_enabled: true,
      discovery_interval_hours: 6,
      max_members: 8,
      members,
    });

    const id = parseSystemIdFromPayload(created);
    if (!id) {
      throw new Error('Failed to create sweep candidate system');
    }

    return id;
  }

  const id = Number(existing.id);
  await api('PUT', `/trading-systems/${API_KEY_NAME}/${id}`, {
    description: 'Candidate portfolio built from third strategy sweep top markets',
    auto_sync_members: true,
    discovery_enabled: true,
    discovery_interval_hours: 6,
    max_members: 8,
  });

  await api('PUT', `/trading-systems/${API_KEY_NAME}/${id}/members`, {
    members,
  });

  return id;
};

const pickMembers = (validated, count) => {
  const sorted = [...validated].sort((a, b) => b.score - a.score);
  const selected = [];

  const bestSynth = sorted.find((item) => item.mode === 'synth');
  const bestMono = sorted.find((item) => item.mode === 'mono');

  if (bestSynth) selected.push(bestSynth);
  if (bestMono && !selected.some((item) => item.strategyId === bestMono.strategyId)) selected.push(bestMono);

  for (const item of sorted) {
    if (selected.length >= count) {
      break;
    }
    if (selected.some((entry) => entry.strategyId === item.strategyId)) {
      continue;
    }
    selected.push(item);
  }

  return selected.slice(0, count);
};

const main = async () => {
  const sweepPath = SWEEP_FILE
    ? path.resolve(process.cwd(), SWEEP_FILE)
    : discoverLatestSweepFile();

  if (!fs.existsSync(sweepPath)) {
    throw new Error(`Sweep file not found: ${sweepPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(sweepPath, 'utf-8'));
  const topScoreSynth = Array.isArray(raw?.topScoreSynth) ? raw.topScoreSynth : [];
  const topScoreMono = Array.isArray(raw?.topScoreMono) ? raw.topScoreMono : [];

  const synthCandidates = pickUniqueByMarket(topScoreSynth, 'synth', TOP_SYNTH);
  const monoCandidates = pickUniqueByMarket(topScoreMono, 'mono', TOP_MONO);
  const candidatePool = [...synthCandidates, ...monoCandidates];

  if (candidatePool.length === 0) {
    throw new Error('No candidates extracted from sweep file');
  }

  console.log(`[START] Import sweep candidates for ${API_KEY_NAME}`);
  console.log(`[SWEEP] ${sweepPath}`);
  console.log(`[POOL] synth=${synthCandidates.length}, mono=${monoCandidates.length}, total=${candidatePool.length}`);

  const strategies = await api('GET', `/strategies/${API_KEY_NAME}`);
  const existingByName = new Map(
    (Array.isArray(strategies) ? strategies : []).map((item) => [String(item?.name || ''), Number(item?.id || 0)])
  );

  const validated = [];

  for (const candidate of candidatePool) {
    const ensured = await ensureStrategy(existingByName, candidate);
    const summary = await runSingleBacktest(ensured.id);
    const score = scoreSummary(summary);

    const record = {
      strategyId: ensured.id,
      strategyName: ensured.name,
      created: ensured.created,
      mode: candidate.mode,
      market: candidate.market,
      tf: candidate.tf,
      len: candidate.len,
      tp: candidate.tp,
      risk: candidate.risk,
      score,
      totalReturnPercent: Number(summary?.totalReturnPercent || 0),
      profitFactor: Number(summary?.profitFactor || 0),
      maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
      winRatePercent: Number(summary?.winRatePercent || 0),
      tradesCount: Number(summary?.tradesCount || 0),
      sweepScore: candidate.sweepScore,
      sweepRet: candidate.sweepRet,
      sweepPf: candidate.sweepPf,
      sweepDd: candidate.sweepDd,
      sweepTrades: candidate.sweepTrades,
    };

    validated.push(record);

    console.log(
      `[CAND] ${record.market} (${record.mode}) id=${record.strategyId} WR=${record.winRatePercent.toFixed(2)} PF=${record.profitFactor.toFixed(2)} DD=${record.maxDrawdownPercent.toFixed(2)} RET=${record.totalReturnPercent.toFixed(2)} SCORE=${record.score.toFixed(2)}`
    );
  }

  const selected = pickMembers(validated, MAX_MEMBERS);
  const members = selected.map((item, index) => ({
    strategy_id: item.strategyId,
    weight: index === 0 ? 1.2 : 1.0,
    member_role: index < 2 ? 'core' : 'satellite',
    is_enabled: true,
    notes: `Sweep candidate ${item.market}`,
  }));

  const systemId = await ensureSystem(members);

  let activationResult = null;
  if (ACTIVATE_SYSTEM) {
    activationResult = await api('POST', `/trading-systems/${API_KEY_NAME}/${systemId}/activation`, {
      isActive: true,
      syncMembers: true,
    });
  }

  const portfolio = await api('POST', `/trading-systems/${API_KEY_NAME}/${systemId}/backtest`, {
    bars: BARS,
    initialBalance: INITIAL_BALANCE,
    commissionPercent: COMMISSION,
    slippagePercent: SLIPPAGE,
    fundingRatePercent: FUNDING,
    saveResult: false,
  });

  const summary = portfolio?.result?.summary || {};

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_sweep_candidate_${stamp}.json`);

  const output = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    sweepFile: sweepPath,
    topSynth: TOP_SYNTH,
    topMono: TOP_MONO,
    maxMembers: MAX_MEMBERS,
    activateSystem: ACTIVATE_SYSTEM,
    candidatePool,
    validated,
    selected,
    systemId,
    activationResult,
    portfolioSummary: {
      finalEquity: Number(summary?.finalEquity || 0),
      totalReturnPercent: Number(summary?.totalReturnPercent || 0),
      maxDrawdownPercent: Number(summary?.maxDrawdownPercent || 0),
      winRatePercent: Number(summary?.winRatePercent || 0),
      profitFactor: Number(summary?.profitFactor || 0),
      tradesCount: Number(summary?.tradesCount || 0),
    },
  };

  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('--- SWEEP SYSTEM SUMMARY ---');
  console.log(`System: ${SYSTEM_NAME} (id=${systemId})`);
  console.log(`Selected members: ${selected.map((item) => item.market).join(', ')}`);
  console.log(
    `Portfolio: RET=${Number(summary?.totalReturnPercent || 0).toFixed(2)} PF=${Number(summary?.profitFactor || 0).toFixed(2)} DD=${Number(summary?.maxDrawdownPercent || 0).toFixed(2)} WR=${Number(summary?.winRatePercent || 0).toFixed(2)} trades=${Number(summary?.tradesCount || 0)}`
  );
  console.log(`Saved: ${outFile}`);
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

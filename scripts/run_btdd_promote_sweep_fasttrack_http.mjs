#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { DEFAULT_API_KEY_NAME, DEFAULT_AUTH_PASSWORD, DEFAULT_BASE_URL } from './btdd_http_defaults.mjs';

const API_KEY_NAME = process.env.API_KEY_NAME || DEFAULT_API_KEY_NAME;
const API_BASE_URL = process.env.BASE_URL || DEFAULT_BASE_URL;
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || DEFAULT_AUTH_PASSWORD;

const TARGET_SYSTEM_NAME = process.env.TARGET_SYSTEM_NAME || `SWEEP ${API_KEY_NAME} Candidate Portfolio`;
const SOURCE_SYSTEM_NAME = process.env.SOURCE_SYSTEM_NAME || `AB ${API_KEY_NAME} Mono Portfolio`;

const TARGET_SYSTEM_ID = Number(process.env.TARGET_SYSTEM_ID || 0);
const SOURCE_SYSTEM_ID = Number(process.env.SOURCE_SYSTEM_ID || 0);

const DEACTIVATE_SOURCE = String(process.env.DEACTIVATE_SOURCE || '1').trim() === '1';
const DEACTIVATE_OTHER_ACTIVE = String(process.env.DEACTIVATE_OTHER_ACTIVE || '0').trim() === '1';
const RUN_PHASE5_CHECK = String(process.env.RUN_PHASE5_CHECK || '1').trim() === '1';
const FAIL_ON_ACTIVE_CRITICAL = String(process.env.FAIL_ON_ACTIVE_CRITICAL || '1').trim() === '1';

const RECON_PERIOD_HOURS = Math.max(1, Number(process.env.RECON_PERIOD_HOURS || 24));
const RECON_BARS = Math.max(120, Number(process.env.RECON_BARS || 336));
const LIQ_TOP_UNIVERSE = Math.max(10, Number(process.env.LIQ_TOP_UNIVERSE || 80));
const LIQ_ADD = Math.max(0, Number(process.env.LIQ_ADD || 2));
const LIQ_REPLACE = Math.max(0, Number(process.env.LIQ_REPLACE || 1));

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

const findSystem = (systems) => {
  if (TARGET_SYSTEM_ID > 0) {
    return systems.find((item) => Number(item?.id || 0) === TARGET_SYSTEM_ID) || null;
  }
  return systems.find((item) => String(item?.name || '') === TARGET_SYSTEM_NAME) || null;
};

const findSourceSystem = (systems) => {
  if (SOURCE_SYSTEM_ID > 0) {
    return systems.find((item) => Number(item?.id || 0) === SOURCE_SYSTEM_ID) || null;
  }
  return systems.find((item) => String(item?.name || '') === SOURCE_SYSTEM_NAME) || null;
};

const collectCriticalItems = (reports, activeStrategyIdSet) => {
  const list = Array.isArray(reports) ? reports : [];
  const critical = list.filter((item) => {
    const severity = String(item?.recommendation?.severity || '').toLowerCase();
    const recommendation = String(item?.recommendation?.recommendation || '').toLowerCase();
    return severity === 'critical' || recommendation === 'pause';
  }).map((item) => ({
    strategyId: Number(item?.strategyId || 0),
    strategyName: String(item?.strategyName || ''),
    symbol: String(item?.symbol || ''),
    recommendation: String(item?.recommendation?.recommendation || ''),
    severity: String(item?.recommendation?.severity || ''),
    rationale: String(item?.recommendation?.rationale || ''),
    samples: Number(item?.metrics?.samples_count || 0),
    active: activeStrategyIdSet.has(Number(item?.strategyId || 0)),
  }));

  return {
    all: critical,
    activeOnly: critical.filter((item) => item.active === true),
  };
};

const main = async () => {
  console.log(`[START] Promote sweep fast-track for ${API_KEY_NAME}`);

  const systemsPayload = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const systems = Array.isArray(systemsPayload) ? systemsPayload : [];

  if (systems.length === 0) {
    throw new Error(`No trading systems found for ${API_KEY_NAME}`);
  }

  const targetSystem = findSystem(systems);
  if (!targetSystem?.id) {
    const names = systems.map((item) => `${item?.id}:${item?.name}`).join(', ');
    throw new Error(`Target system not found (${TARGET_SYSTEM_NAME}). Available: ${names}`);
  }

  const sourceSystem = findSourceSystem(systems);
  const actions = [];

  if (DEACTIVATE_SOURCE && sourceSystem?.id && Number(sourceSystem.id) !== Number(targetSystem.id) && sourceSystem?.is_active === true) {
    await api('POST', `/trading-systems/${API_KEY_NAME}/${Number(sourceSystem.id)}/activation`, {
      isActive: false,
      syncMembers: false,
    });
    actions.push(`deactivated source system id=${Number(sourceSystem.id)} name=${String(sourceSystem.name || '')}`);
  }

  if (DEACTIVATE_OTHER_ACTIVE) {
    const otherActive = systems.filter((item) => item?.is_active === true && Number(item?.id || 0) !== Number(targetSystem.id));
    for (const item of otherActive) {
      await api('POST', `/trading-systems/${API_KEY_NAME}/${Number(item.id)}/activation`, {
        isActive: false,
        syncMembers: false,
      });
      actions.push(`deactivated other active system id=${Number(item.id)} name=${String(item.name || '')}`);
    }
  }

  await api('POST', `/trading-systems/${API_KEY_NAME}/${Number(targetSystem.id)}/activation`, {
    isActive: true,
    syncMembers: true,
  });
  actions.push(`activated target system id=${Number(targetSystem.id)} name=${String(targetSystem.name || '')}`);

  const strategiesNow = await api('GET', `/strategies/${API_KEY_NAME}`);
  const activeStrategies = (Array.isArray(strategiesNow) ? strategiesNow : []).filter((item) => item?.is_active === true);
  const activeStrategyIdSet = new Set(activeStrategies.map((item) => Number(item?.id || 0)).filter((id) => id > 0));

  let reconciliation = null;
  let liquidityScan = null;
  let analysis = null;
  let critical = { all: [], activeOnly: [] };

  if (RUN_PHASE5_CHECK) {
    reconciliation = await api('POST', `/analytics/${API_KEY_NAME}/reconciliation/run`, {
      periodHours: RECON_PERIOD_HOURS,
      backtestBars: RECON_BARS,
      autoApplyAdjustments: false,
      autoPauseOnCritical: false,
    });

    liquidityScan = await api('POST', `/analytics/${API_KEY_NAME}/liquidity-scan/run`, {
      topUniverseLimit: LIQ_TOP_UNIVERSE,
      maxAddSuggestions: LIQ_ADD,
      maxReplaceSuggestions: LIQ_REPLACE,
    });

    analysis = await api('POST', `/analytics/${API_KEY_NAME}/system/${Number(targetSystem.id)}/analysis`, {
      periodHours: RECON_PERIOD_HOURS,
    });

    critical = collectCriticalItems(analysis?.reports, activeStrategyIdSet);
  }

  const systemsAfterPayload = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const systemsAfter = Array.isArray(systemsAfterPayload) ? systemsAfterPayload : [];
  const activeSystemsAfter = systemsAfter.filter((item) => item?.is_active === true);

  const output = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    targetSystemId: Number(targetSystem.id),
    targetSystemName: String(targetSystem.name || ''),
    sourceSystemId: Number(sourceSystem?.id || 0),
    sourceSystemName: String(sourceSystem?.name || ''),
    actions,
    activeStrategies: activeStrategies.length,
    activeSystemsAfter: activeSystemsAfter.map((item) => ({ id: Number(item?.id || 0), name: String(item?.name || '') })),
    checks: {
      runPhase5Check: RUN_PHASE5_CHECK,
      reconciliation,
      liquidityScan,
      criticalAll: critical.all,
      criticalActiveOnly: critical.activeOnly,
    },
  };

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_promote_sweep_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('--- FAST-TRACK SUMMARY ---');
  for (const action of actions) {
    console.log(`- ${action}`);
  }
  console.log(`Active strategies: ${activeStrategies.length}`);
  console.log(`Active systems after switch: ${activeSystemsAfter.map((item) => `${item.name}(id=${item.id})`).join(', ') || 'none'}`);

  if (RUN_PHASE5_CHECK) {
    console.log(`Reconciliation: processed=${Number(reconciliation?.processed || 0)}, failed=${Number(reconciliation?.failed || 0)}`);
    console.log(`Liquidity scan: systems=${Number(liquidityScan?.scannedSystems || 0)}, suggestionsCreated=${Number(liquidityScan?.createdSuggestions || 0)}`);
    console.log(`Critical/pause recommendations (all members): ${critical.all.length}`);
    console.log(`Critical/pause recommendations (active only): ${critical.activeOnly.length}`);
    if (critical.all.length > 0) {
      for (const item of critical.all) {
        console.log(`  - ${item.strategyName || item.symbol || item.strategyId} | rec=${item.recommendation} | severity=${item.severity} | samples=${item.samples} | ${item.active ? 'active' : 'inactive'}`);
      }
    }
  }

  console.log(`Saved: ${outFile}`);

  if (RUN_PHASE5_CHECK && FAIL_ON_ACTIVE_CRITICAL && critical.activeOnly.length > 0) {
    throw new Error(`Active critical recommendations detected: ${critical.activeOnly.length}`);
  }
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

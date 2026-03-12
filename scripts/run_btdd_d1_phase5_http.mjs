#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const API_KEY_NAME = process.env.API_KEY_NAME || 'BTDD_D1';
const API_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'defaultpassword';

const RECON_PERIOD_HOURS = Number(process.env.RECON_PERIOD_HOURS || 24);
const RECON_BARS = Number(process.env.RECON_BARS || 336);
const LIQ_TOP_UNIVERSE = Number(process.env.LIQ_TOP_UNIVERSE || 80);
const LIQ_ADD = Number(process.env.LIQ_ADD || 2);
const LIQ_REPLACE = Number(process.env.LIQ_REPLACE || 1);
const ENABLE_DISCOVERY = String(process.env.ENABLE_DISCOVERY || '0').trim() === '1';
const DISCOVERY_INTERVAL_HOURS = Math.max(1, Number(process.env.DISCOVERY_INTERVAL_HOURS || 6));

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

const main = async () => {
  console.log(`[START] Phase5 check for ${API_KEY_NAME}`);

  const strategies = await api('GET', `/strategies/${API_KEY_NAME}`);
  let systemsPayload = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  let systems = Array.isArray(systemsPayload) ? systemsPayload : [];

  const activeStrategies = (Array.isArray(strategies) ? strategies : []).filter((s) => s?.is_active === true);
  const activeStrategyIdSet = new Set(
    activeStrategies.map((item) => Number(item?.id || 0)).filter((id) => id > 0)
  );
  let activeSystems = systems.filter((s) => s?.is_active === true);

  let discoveryAutoEnabled = false;
  let primarySystem = activeSystems[0] || systems[0] || null;

  if (ENABLE_DISCOVERY && primarySystem?.id && primarySystem?.discovery_enabled !== true) {
    await api('PUT', `/trading-systems/${API_KEY_NAME}/${Number(primarySystem.id)}`, {
      discovery_enabled: true,
      discovery_interval_hours: DISCOVERY_INTERVAL_HOURS,
    });

    discoveryAutoEnabled = true;
    systemsPayload = await api('GET', `/trading-systems/${API_KEY_NAME}`);
    systems = Array.isArray(systemsPayload) ? systemsPayload : [];
    activeSystems = systems.filter((s) => s?.is_active === true);
    primarySystem = activeSystems[0] || systems[0] || null;
  }

  const discoveryEnabledSystems = systems.filter((s) => s?.discovery_enabled === true);

  const reconciliation = await api('POST', `/analytics/${API_KEY_NAME}/reconciliation/run`, {
    periodHours: RECON_PERIOD_HOURS,
    backtestBars: RECON_BARS,
    autoApplyAdjustments: false,
    autoPauseOnCritical: false,
  });

  const liquidityScan = await api('POST', `/analytics/${API_KEY_NAME}/liquidity-scan/run`, {
    topUniverseLimit: LIQ_TOP_UNIVERSE,
    maxAddSuggestions: LIQ_ADD,
    maxReplaceSuggestions: LIQ_REPLACE,
  });

  const reports = await api('GET', `/analytics/${API_KEY_NAME}/reconciliation/reports?limit=10`);
  const suggestions = await api('GET', `/analytics/${API_KEY_NAME}/liquidity-suggestions?status=new&limit=20`);

  let systemAnalysis = null;
  let criticalRecommendations = 0;
  let criticalRecommendationsActive = 0;
  let criticalItems = [];
  let criticalItemsActive = [];

  if (primarySystem?.id) {
    systemAnalysis = await api('POST', `/analytics/${API_KEY_NAME}/system/${Number(primarySystem.id)}/analysis`, {
      periodHours: RECON_PERIOD_HOURS,
    });

    const analysisReports = Array.isArray(systemAnalysis?.reports) ? systemAnalysis.reports : [];
    criticalItems = analysisReports.filter((item) => {
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
    }));

    criticalRecommendations = criticalItems.length;
    criticalItemsActive = criticalItems.filter((item) => activeStrategyIdSet.has(item.strategyId));
    criticalRecommendationsActive = criticalItemsActive.length;
  }

  const latestReport = Array.isArray(reports?.reports) && reports.reports.length > 0
    ? reports.reports[0]
    : null;

  const notes = [];
  if (Number(liquidityScan?.scannedSystems || 0) === 0) {
    notes.push('Liquidity scan skipped: no discovery-enabled trading systems. Enable discovery or run with ENABLE_DISCOVERY=1.');
  }
  if (criticalRecommendations > 0) {
    notes.push(`System analysis has ${criticalRecommendations} critical/pause recommendations (all members).`);
  }
  if (criticalRecommendationsActive > 0) {
    notes.push(`Active strategies have ${criticalRecommendationsActive} critical/pause recommendations.`);
  }
  if (activeStrategies.length === 0) {
    notes.push('No active strategies for this API key.');
  }

  const output = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    activeStrategies: activeStrategies.length,
    activeSystems: activeSystems.length,
    discoveryEnabledSystems: discoveryEnabledSystems.length,
    discoveryAutoEnabled,
    primarySystemId: Number(primarySystem?.id || 0),
    reconciliation,
    liquidityScan,
    criticalRecommendations,
    criticalRecommendationsActive,
    criticalItems,
    criticalItemsActive,
    reportsCount: Number(reports?.count || 0),
    suggestionsCount: Number(suggestions?.count || 0),
    systemAnalysis,
    latestReport,
    notes,
  };

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_phase5_${stamp}.json`);
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2));

  console.log('--- SUMMARY ---');
  console.log(`Active strategies: ${activeStrategies.length}`);
  console.log(`Active systems: ${activeSystems.length}`);
  console.log(`Discovery-enabled systems: ${discoveryEnabledSystems.length} (autoEnabled=${discoveryAutoEnabled})`);
  console.log(`Reconciliation: processed=${Number(reconciliation?.processed || 0)}, failed=${Number(reconciliation?.failed || 0)}`);
  console.log(`Liquidity scan: systems=${Number(liquidityScan?.scannedSystems || 0)}, suggestionsCreated=${Number(liquidityScan?.createdSuggestions || 0)}`);
  console.log(`Critical/pause recommendations (all members): ${criticalRecommendations}`);
  console.log(`Critical/pause recommendations (active only): ${criticalRecommendationsActive}`);
  if (criticalItems.length > 0) {
    for (const item of criticalItems) {
      const activeMark = activeStrategyIdSet.has(item.strategyId) ? 'active' : 'inactive';
      console.log(
        `  - ${item.strategyName || item.symbol || item.strategyId} | rec=${item.recommendation} | severity=${item.severity} | samples=${item.samples} | ${activeMark}`
      );
      if (item.rationale) {
        console.log(`    rationale: ${item.rationale}`);
      }
    }
  }
  console.log(`Stored reports: ${Number(reports?.count || 0)}, new suggestions: ${Number(suggestions?.count || 0)}`);
  if (notes.length > 0) {
    console.log(`Notes: ${notes.join(' | ')}`);
  }
  console.log(`Saved snapshot: ${outFile}`);
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

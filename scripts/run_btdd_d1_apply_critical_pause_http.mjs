#!/usr/bin/env node

import fs from 'fs';
import path from 'path';

const API_KEY_NAME = process.env.API_KEY_NAME || 'BTDD_D1';
const API_BASE_URL = process.env.BASE_URL || 'http://127.0.0.1:3001/api';
const AUTH_PASSWORD = process.env.AUTH_PASSWORD || 'defaultpassword';

const PERIOD_HOURS = Math.max(1, Number(process.env.PERIOD_HOURS || 24));
const MAX_TO_PAUSE = Math.max(1, Number(process.env.MAX_TO_PAUSE || 1));
const DISABLE_MEMBER = String(process.env.DISABLE_MEMBER || '0').trim() === '1';

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

const isCriticalOrPause = (report) => {
  const severity = String(report?.recommendation?.severity || '').toLowerCase();
  const rec = String(report?.recommendation?.recommendation || '').toLowerCase();
  return severity === 'critical' || rec === 'pause';
};

const main = async () => {
  console.log(`[START] Apply critical pause for ${API_KEY_NAME}`);

  const strategies = await api('GET', `/strategies/${API_KEY_NAME}`);
  const strategyList = Array.isArray(strategies) ? strategies : [];
  const activeStrategyIds = new Set(
    strategyList.filter((s) => s?.is_active === true).map((s) => Number(s?.id || 0)).filter((id) => id > 0)
  );

  const systems = await api('GET', `/trading-systems/${API_KEY_NAME}`);
  const systemList = Array.isArray(systems) ? systems : [];
  const primarySystem = systemList.find((s) => s?.is_active === true) || systemList[0] || null;

  if (!primarySystem?.id) {
    throw new Error('No trading system found for API key');
  }

  const systemId = Number(primarySystem.id);
  const analysis = await api('POST', `/analytics/${API_KEY_NAME}/system/${systemId}/analysis`, {
    periodHours: PERIOD_HOURS,
  });

  const reports = Array.isArray(analysis?.reports) ? analysis.reports : [];
  const flagged = reports
    .filter((report) => isCriticalOrPause(report))
    .filter((report) => activeStrategyIds.has(Number(report?.strategyId || 0)))
    .slice(0, MAX_TO_PAUSE)
    .map((report) => ({
      strategyId: Number(report?.strategyId || 0),
      strategyName: String(report?.strategyName || ''),
      symbol: String(report?.symbol || ''),
      recommendation: String(report?.recommendation?.recommendation || ''),
      severity: String(report?.recommendation?.severity || ''),
      rationale: String(report?.recommendation?.rationale || ''),
      samples: Number(report?.metrics?.samples_count || 0),
    }))
    .filter((item) => item.strategyId > 0);

  if (flagged.length === 0) {
    console.log('No active critical/pause recommendations found. No action applied.');
    return;
  }

  const paused = [];
  for (const item of flagged) {
    await api('PUT', `/strategies/${API_KEY_NAME}/${item.strategyId}`, {
      is_active: false,
      last_action: 'paused_by_phase5_critical',
      last_error: item.rationale || 'Paused due to critical/pause recommendation',
    });

    paused.push(item);
    console.log(
      `[PAUSED] ${item.strategyName || item.symbol || item.strategyId} | severity=${item.severity} | rec=${item.recommendation}`
    );
  }

  let membersDisabled = [];

  if (DISABLE_MEMBER) {
    const fullSystem = await api('GET', `/trading-systems/${API_KEY_NAME}/${systemId}`);
    const members = Array.isArray(fullSystem?.members) ? fullSystem.members : [];
    const pausedIds = new Set(paused.map((item) => item.strategyId));

    const nextMembers = members.map((member) => {
      const strategyId = Number(member?.strategy_id || 0);
      const shouldDisable = pausedIds.has(strategyId);

      if (shouldDisable) {
        membersDisabled.push(strategyId);
      }

      return {
        strategy_id: strategyId,
        weight: Number(member?.weight || 1),
        member_role: String(member?.member_role || 'core'),
        is_enabled: shouldDisable ? false : member?.is_enabled !== false,
        notes: String(member?.notes || ''),
      };
    });

    await api('PUT', `/trading-systems/${API_KEY_NAME}/${systemId}/members`, {
      members: nextMembers,
    });

    if (membersDisabled.length > 0) {
      console.log(`[SYSTEM] Disabled members in system ${systemId}: ${membersDisabled.join(', ')}`);
    }
  }

  const outDir = path.resolve(process.cwd(), 'results');
  fs.mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outFile = path.join(outDir, `${API_KEY_NAME.toLowerCase()}_critical_pause_${stamp}.json`);

  const payload = {
    timestamp: new Date().toISOString(),
    apiKeyName: API_KEY_NAME,
    systemId,
    paused,
    disableMemberMode: DISABLE_MEMBER,
    membersDisabled,
  };

  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2));
  console.log(`Saved action report: ${outFile}`);
};

main().catch((error) => {
  console.error('[FAIL]', error?.message || error);
  process.exit(1);
});

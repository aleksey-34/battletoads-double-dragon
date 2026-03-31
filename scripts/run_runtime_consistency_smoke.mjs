import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.BTDD_BASE_URL || process.argv[2] || 'http://127.0.0.1:3001').replace(/\/$/, '');
const bearerToken = process.env.BTDD_BEARER_TOKEN || process.env.BTDD_DASHBOARD_PASSWORD || 'SuperSecure2026Admin!';
const apiKeyName = process.env.BTDD_RUNTIME_KEY || 'BTDD_D1';
const systemIdRaw = process.env.BTDD_RUNTIME_SYSTEM_ID || '';
const failOnErrorDesync = Math.max(0, Number(process.env.BTDD_RUNTIME_FAIL_ERROR_DESYNC ?? 1));

const reportDir = path.resolve(process.cwd(), 'logs', 'smoke');
fs.mkdirSync(reportDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `runtime-consistency-${apiKeyName}-${timestamp}.json`);

const headers = bearerToken
  ? { Authorization: `Bearer ${bearerToken}` }
  : {};

const getJson = async (urlPath) => {
  const response = await fetch(`${baseUrl}${urlPath}`, { headers });
  const text = await response.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }

  return {
    ok: response.ok,
    status: response.status,
    text,
    json,
  };
};

const normalizePositionSide = (raw) => {
  const side = String(raw || '').trim().toLowerCase();
  if (side === 'buy') {
    return 'long';
  }
  if (side === 'sell') {
    return 'short';
  }
  return 'flat';
};

const inferLiveState = (strategy, positions) => {
  const pick = (symbolRaw) => {
    const symbol = String(symbolRaw || '').toUpperCase().trim();
    if (!symbol) {
      return null;
    }

    return (positions || []).find((row) => {
      const rowSymbol = String(row?.symbol || '').toUpperCase().trim();
      const size = Number(row?.size || 0);
      return rowSymbol === symbol && Number.isFinite(size) && size > 0;
    }) || null;
  };

  const base = pick(strategy.base_symbol);
  if (String(strategy.market_mode || 'synthetic') === 'mono') {
    const side = normalizePositionSide(base?.side);
    if (!base || side === 'flat') {
      return 'flat';
    }
    return side;
  }

  const quote = pick(strategy.quote_symbol);
  const baseSide = normalizePositionSide(base?.side);
  const quoteSide = normalizePositionSide(quote?.side);

  if (!base && !quote) {
    return 'flat';
  }

  if (!base || !quote || baseSide === 'flat' || quoteSide === 'flat') {
    return 'mixed';
  }

  if (baseSide === 'long' && quoteSide === 'short') {
    return 'long';
  }
  if (baseSide === 'short' && quoteSide === 'long') {
    return 'short';
  }
  return 'mixed';
};

const classifyDesync = (strategy, liveState) => {
  const runtimeStateRaw = String(strategy?.state || 'flat').toLowerCase();
  const runtimeState = runtimeStateRaw === 'long' || runtimeStateRaw === 'short' ? runtimeStateRaw : 'flat';

  if (liveState === 'mixed') {
    return { status: 'error', reason: 'mixed_live_legs' };
  }
  if (runtimeState === 'flat' && liveState !== 'flat') {
    return { status: 'error', reason: 'ghost_live_position' };
  }
  if (runtimeState !== 'flat' && liveState === 'flat') {
    return { status: 'error', reason: 'stale_runtime_state' };
  }
  if (runtimeState !== 'flat' && liveState !== 'flat' && runtimeState !== liveState) {
    return { status: 'error', reason: 'side_mismatch' };
  }

  const lastError = String(strategy?.last_error || '').trim();
  if (lastError) {
    return { status: 'warning', reason: 'runtime_error_present' };
  }

  return { status: 'ok', reason: 'synced' };
};

const resolveSystemId = async () => {
  if (systemIdRaw) {
    const parsed = Number(systemIdRaw);
    if (Number.isFinite(parsed) && parsed > 0) {
      return parsed;
    }
  }

  const systemsResp = await getJson(`/api/trading-systems/${encodeURIComponent(apiKeyName)}`);
  if (!systemsResp.ok || !Array.isArray(systemsResp.json)) {
    throw new Error(`Failed to fetch trading systems: status=${systemsResp.status}`);
  }

  const active = systemsResp.json.find((row) => Number(row?.is_active || 0) === 1);
  if (!active || !Number(active.id)) {
    throw new Error(`No active trading system found for ${apiKeyName}`);
  }

  return Number(active.id);
};

const main = async () => {
  const startedAt = Date.now();
  const systemId = await resolveSystemId();

  const [systemResp, summaryResp, positionsResp] = await Promise.all([
    getJson(`/api/trading-systems/${encodeURIComponent(apiKeyName)}/${systemId}`),
    getJson(`/api/strategies/${encodeURIComponent(apiKeyName)}/summary?limit=500&offset=0&runtimeOnly=1&includeArchived=1`),
    getJson(`/api/positions/${encodeURIComponent(apiKeyName)}`),
  ]);

  if (!systemResp.ok) {
    throw new Error(`System detail request failed: status=${systemResp.status}`);
  }
  if (!summaryResp.ok) {
    throw new Error(`Runtime summary request failed: status=${summaryResp.status}`);
  }
  if (!positionsResp.ok) {
    throw new Error(`Positions request failed: status=${positionsResp.status}`);
  }

  const members = Array.isArray(systemResp.json?.members) ? systemResp.json.members : [];
  const enabledMembers = members.filter((row) => Boolean(row?.is_enabled));
  const runtimeSummaries = Array.isArray(summaryResp.json) ? summaryResp.json : [];
  const byId = new Map(runtimeSummaries.map((row) => [Number(row?.id || 0), row]));
  const positions = Array.isArray(positionsResp.json) ? positionsResp.json : [];

  const openPositions = positions.filter((row) => {
    const size = Number(row?.size || 0);
    return Number.isFinite(size) && size > 0;
  });

  const diagnostics = enabledMembers.map((member) => {
    const strategyId = Number(member?.strategy_id || 0);
    const strategy = member?.strategy || byId.get(strategyId) || {};
    const liveState = inferLiveState(strategy, positions);
    const classification = classifyDesync(strategy, liveState);
    return {
      strategyId,
      strategyName: String(strategy?.name || `#${strategyId}`),
      pair: [strategy?.base_symbol, strategy?.quote_symbol].filter(Boolean).join('/'),
      runtimeState: String(strategy?.state || 'flat'),
      liveState,
      lastSignal: String(strategy?.last_signal || ''),
      lastAction: String(strategy?.last_action || ''),
      status: classification.status,
      reason: classification.reason,
      weight: Number(member?.weight || 0),
    };
  });

  const totals = diagnostics.reduce(
    (acc, row) => {
      if (row.status === 'error') {
        acc.errors += 1;
      } else if (row.status === 'warning') {
        acc.warnings += 1;
      } else {
        acc.ok += 1;
      }
      return acc;
    },
    { ok: 0, warnings: 0, errors: 0 }
  );

  const report = {
    generatedAt: new Date().toISOString(),
    baseUrl,
    apiKeyName,
    systemId,
    elapsedMs: Date.now() - startedAt,
    totals,
    openPositionsCount: openPositions.length,
    openPositions: openPositions.map((row) => ({
      symbol: row?.symbol,
      side: row?.side,
      size: Number(row?.size || 0),
      unrealisedPnl: Number(row?.unrealisedPnl || 0),
    })),
    memberCount: enabledMembers.length,
    diagnostics,
  };

  fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

  console.log(`Runtime smoke report: ${reportPath}`);
  console.log(`API key=${apiKeyName}, systemId=${systemId}, members=${enabledMembers.length}, openPositions=${openPositions.length}`);
  console.log(`Status: ok=${totals.ok}, warnings=${totals.warnings}, errors=${totals.errors}`);

  diagnostics
    .filter((row) => row.status !== 'ok')
    .slice(0, 20)
    .forEach((row) => {
      console.log(`${row.status.toUpperCase()} | id=${row.strategyId} | ${row.strategyName} | runtime=${row.runtimeState} live=${row.liveState} | ${row.reason}`);
    });

  if (totals.errors >= failOnErrorDesync) {
    process.exitCode = 1;
  }
};

main().catch((error) => {
  console.error(`Runtime consistency smoke failed: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});

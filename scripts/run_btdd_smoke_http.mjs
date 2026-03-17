import fs from 'node:fs';
import path from 'node:path';

const baseUrl = (process.env.BTDD_BASE_URL || process.argv[2] || 'http://176.57.184.98').replace(/\/$/, '');
const bearerToken = process.env.BTDD_BEARER_TOKEN || process.env.BTDD_DASHBOARD_PASSWORD || '';
const apiKeys = String(process.env.BTDD_SMOKE_KEYS || '')
  .split(',')
  .map((value) => value.trim())
  .filter(Boolean);
const tradeSymbol = process.env.BTDD_SMOKE_SYMBOL || 'BTCUSDT';

const reportDir = path.resolve(process.cwd(), 'logs', 'smoke');
fs.mkdirSync(reportDir, { recursive: true });

const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
const reportPath = path.join(reportDir, `smoke-${timestamp}.json`);

const defaultHeaders = bearerToken
  ? {
      Authorization: `Bearer ${bearerToken}`,
    }
  : {};

const publicChecks = [
  { name: 'home', url: '/' },
  { name: 'login', url: '/login' },
  { name: 'saas', url: '/saas' },
  { name: 'trading-systems', url: '/trading-systems' },
];

const protectedChecks = [
  { name: 'api-keys', url: '/api/api-keys', auth: true },
  { name: 'saas-summary', url: '/api/saas/admin/summary', auth: true },
  { name: 'update-status', url: '/api/system/update/status', auth: true },
  { name: 'update-job', url: '/api/system/update/job', auth: true },
];

for (const keyName of apiKeys) {
  protectedChecks.push(
    { name: `balances:${keyName}`, url: `/api/balances/${encodeURIComponent(keyName)}`, auth: true },
    { name: `positions:${keyName}`, url: `/api/positions/${encodeURIComponent(keyName)}`, auth: true },
    { name: `orders:${keyName}`, url: `/api/orders/${encodeURIComponent(keyName)}`, auth: true },
    { name: `trades:${keyName}`, url: `/api/trades/${encodeURIComponent(keyName)}`, auth: true },
    { name: `trades-symbol:${keyName}`, url: `/api/trades/${encodeURIComponent(keyName)}?symbol=${encodeURIComponent(tradeSymbol)}`, auth: true },
    { name: `monitoring:${keyName}`, url: `/api/monitoring/${encodeURIComponent(keyName)}?limit=50`, auth: true },
    { name: `market-data:${keyName}`, url: `/api/market-data/${encodeURIComponent(keyName)}?symbol=${encodeURIComponent(tradeSymbol)}&interval=1h&limit=20`, auth: true },
  );
}

const checks = [...publicChecks, ...protectedChecks];

const summarizeBody = (body) => {
  if (!body) {
    return '';
  }

  return String(body).replace(/\s+/g, ' ').trim().slice(0, 240);
};

const runCheck = async (check) => {
  if (check.auth && !bearerToken) {
    return {
      ...check,
      skipped: true,
      ok: true,
      status: null,
      durationMs: 0,
      snippet: 'Skipped: no bearer token provided',
    };
  }

  const startedAt = Date.now();

  try {
    const response = await fetch(`${baseUrl}${check.url}`, {
      method: 'GET',
      headers: check.auth ? defaultHeaders : undefined,
    });
    const body = await response.text();

    return {
      ...check,
      skipped: false,
      ok: response.ok,
      status: response.status,
      durationMs: Date.now() - startedAt,
      snippet: summarizeBody(body),
    };
  } catch (error) {
    return {
      ...check,
      skipped: false,
      ok: false,
      status: null,
      durationMs: Date.now() - startedAt,
      snippet: error instanceof Error ? error.message : String(error),
    };
  }
};

const results = [];
for (const check of checks) {
  results.push(await runCheck(check));
}

const totals = results.reduce(
  (acc, item) => {
    if (item.skipped) {
      acc.skipped += 1;
    } else if (item.ok) {
      acc.passed += 1;
    } else {
      acc.failed += 1;
    }
    return acc;
  },
  { passed: 0, failed: 0, skipped: 0 }
);

const report = {
  generatedAt: new Date().toISOString(),
  baseUrl,
  hasBearerToken: Boolean(bearerToken),
  apiKeys,
  tradeSymbol,
  totals,
  results,
};

fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

for (const item of results) {
  const statusLabel = item.skipped ? 'SKIP' : item.ok ? 'PASS' : 'FAIL';
  const code = item.status === null ? '-' : String(item.status);
  console.log(`${statusLabel}\t${code}\t${item.durationMs}ms\t${item.name}\t${item.url}`);
  if (!item.ok && !item.skipped && item.snippet) {
    console.log(`  ${item.snippet}`);
  }
}

console.log(`Report written to ${reportPath}`);
console.log(`Summary: ${totals.passed} passed, ${totals.failed} failed, ${totals.skipped} skipped`);

if (totals.failed > 0) {
  process.exitCode = 1;
}
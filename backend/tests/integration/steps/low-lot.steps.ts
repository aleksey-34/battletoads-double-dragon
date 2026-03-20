import assert from 'assert';
import request, { Response } from 'supertest';
import { Given, Then, When } from '@cucumber/cucumber';

// Re-use shared state from api.steps.ts via module-level side-effect imports.
// We import carefully to avoid re-running BeforeAll/AfterAll hooks.
// Step state is shared through the CommonJS module singleton.

// Access shared test state through a re-export from the parent steps file.
// Since Cucumber loads all step files into the same world, we need to share state.
// We use a simple module-level object that is populated by both step files.

type SharedState = {
  app: import('express').Express;
  response: Response | null;
  password: string;
  dbFile: string;
};

// Import the shared state object exported from api.steps.ts
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedState: SharedState = require('./api.steps').sharedState;

// ── Extra step: POST with body ─────────────────────────────────────────────

When(
  /^I POST to "([^"]+)" without auth with body (.+)$/,
  async (routePath: string, bodyJson: string) => {
    const body = JSON.parse(bodyJson) as Record<string, unknown>;
    sharedState.response = await request(sharedState.app).post(routePath).send(body);
  }
);

When(
  /^I POST to "([^"]+)" with auth with body (.+)$/,
  async (routePath: string, bodyJson: string) => {
    const body = JSON.parse(bodyJson) as Record<string, unknown>;
    sharedState.response = await request(sharedState.app)
      .post(routePath)
      .set('Authorization', `Bearer ${sharedState.password}`)
      .send(body);
  }
);

// ── Extra assertions ───────────────────────────────────────────────────────

Then('the items list should be empty', () => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const items = sharedState.response!.body?.items;
  assert.ok(Array.isArray(items), 'Expected items to be an array');
  assert.strictEqual(items.length, 0, `Expected empty items list, got ${items.length} items`);
});

Then('the items list should contain a recommendation for strategy {string}', (strategyName: string) => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const items: Array<Record<string, unknown>> = sharedState.response!.body?.items || [];
  assert.ok(Array.isArray(items), 'Expected items to be an array');
  const found = items.some((item) => String(item.strategyName || '').includes(strategyName));
  assert.ok(found, `Expected to find strategy "${strategyName}" in items: ${JSON.stringify(items.map((i) => i.strategyName))}`);
});

Then('the items list should contain a recommendation with pair {string}', (pair: string) => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const items: Array<Record<string, unknown>> = sharedState.response!.body?.items || [];
  assert.ok(Array.isArray(items), 'Expected items to be an array');
  const found = items.some((item) => String(item.pair || '').includes(pair));
  assert.ok(found, `Expected to find pair "${pair}" in items: ${JSON.stringify(items.map((i) => i.pair))}`);
});

// ── DB setup helpers ───────────────────────────────────────────────────────

// We track created IDs for follow-up steps.
let lastCreatedStrategyId = 0;
let lastCreatedApiKeyId = 0;

Given('an API key {string} exists in the database', async (apiKeyName: string) => {
  const { db } = await import('../../../src/utils/database');
  const existing = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (existing) {
    lastCreatedApiKeyId = Number(existing.id);
    return;
  }
  const result: any = await db.run(
    `INSERT INTO api_keys (name, exchange, api_key, secret) VALUES (?, 'bybit', 'test_key', 'test_secret')`,
    [apiKeyName]
  );
  lastCreatedApiKeyId = Number(result?.lastID || 0);
});

Given(
  'a strategy {string} exists for {string} with deposit {float} and lot {float}',
  async (name: string, apiKeyName: string, deposit: number, lot: number) => {
    const { db } = await import('../../../src/utils/database');
    const apiKeyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
    const apiKeyId = Number(apiKeyRow?.id || 0);
    assert.ok(apiKeyId > 0, `API key "${apiKeyName}" not found`);

    const result: any = await db.run(
      `INSERT INTO strategies (name, api_key_id, is_active, auto_update, max_deposit, lot_long_percent, lot_short_percent, base_symbol, quote_symbol)
       VALUES (?, ?, 1, 1, ?, ?, ?, 'ORDI', 'USDT')`,
      [name, apiKeyId, deposit, lot, lot]
    );
    lastCreatedStrategyId = Number(result?.lastID || 0);
  }
);

Given('a low-lot runtime event exists for {string} and the strategy', async (apiKeyName: string) => {
  const { db } = await import('../../../src/utils/database');
  await db.run(
    `INSERT INTO strategy_runtime_events (api_key_name, strategy_id, strategy_name, event_type, message, resolved_at, created_at)
     VALUES (?, ?, 'LowLot Strategy', 'low_lot_error', 'Order size too small for balanced pair execution', 0, ?)`,
    [apiKeyName, lastCreatedStrategyId, Date.now()]
  );
});

Given('a liquidity trigger event exists for {string} with symbol {string}', async (apiKeyName: string, symbol: string) => {
  const { db } = await import('../../../src/utils/database');
  await db.run(
    `INSERT INTO strategy_runtime_events (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
     VALUES (?, NULL, '', 'liquidity_trigger', ?, ?, 0, ?)`,
    [
      apiKeyName,
      `Liquidity replacement candidate: ${symbol} (score 3.50) for system 1.`,
      JSON.stringify({ symbol, systemId: 1, reason: 'High liquidity candidate' }),
      Date.now(),
    ]
  );
});

When('I apply the recommendation for the strategy with deposit fix', async () => {
  sharedState.response = await request(sharedState.app)
    .post('/api/saas/admin/apply-low-lot-recommendation')
    .set('Authorization', `Bearer ${sharedState.password}`)
    .send({ strategyId: lastCreatedStrategyId, applyDepositFix: true, applyLotFix: false });
});

Then('the runtime event for the strategy should be resolved', async () => {
  const { db } = await import('../../../src/utils/database');
  const event = await db.get(
    `SELECT resolved_at FROM strategy_runtime_events
     WHERE strategy_id = ? AND event_type = 'low_lot_error'
     ORDER BY id DESC LIMIT 1`,
    [lastCreatedStrategyId]
  );
  assert.ok(event, 'Expected runtime event to exist');
  assert.ok(Number(event.resolved_at) > 0, `Expected resolved_at > 0, got: ${event.resolved_at}`);
});

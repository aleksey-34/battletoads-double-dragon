import assert from 'assert';
import request from 'supertest';
import { Given, Then, When } from '@cucumber/cucumber';

// Reuse app/password lifecycle from existing integration steps.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedState: {
  app: import('express').Express;
  response: import('supertest').Response | null;
  password: string;
} = require('./api.steps').sharedState;

type FixtureMap = Record<string, number>;

const fixtureStrategyIds: FixtureMap = {};
let lastPostedStrategy: Record<string, unknown> | null = null;

const parseJson = (rawBody: string): Record<string, unknown> => {
  try {
    return JSON.parse(rawBody) as Record<string, unknown>;
  } catch {
    return {};
  }
};

const authHeader = () => `Bearer ${sharedState.password}`;

const ensureApiKey = async (apiKeyName: string): Promise<number> => {
  const { db } = await import('../../../src/utils/database');
  const existing = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (existing?.id) {
    return Number(existing.id);
  }

  const insert: any = await db.run(
    `INSERT INTO api_keys (name, exchange, api_key, secret) VALUES (?, 'bybit', 'cucumber_key', 'cucumber_secret')`,
    [apiKeyName]
  );

  return Number(insert?.lastID || 0);
};

Given('runtime test API key {string} exists', async (apiKeyName: string) => {
  const id = await ensureApiKey(apiKeyName);
  assert.ok(id > 0, `Failed to ensure API key: ${apiKeyName}`);
});

Given('runtime fixture {string} exists for {string} with body:', async (fixtureName: string, apiKeyName: string, rawBody: string) => {
  const apiKeyId = await ensureApiKey(apiKeyName);
  const payload = parseJson(rawBody);
  const strategyName = String(payload.name || fixtureName || 'runtime-fixture');

  const { db } = await import('../../../src/utils/database');

  const existing = await db.get(
    `SELECT id FROM strategies WHERE api_key_id = ? AND name = ? ORDER BY id DESC LIMIT 1`,
    [apiKeyId, strategyName]
  );

  if (existing?.id) {
    fixtureStrategyIds[fixtureName] = Number(existing.id);
    return;
  }

  const insert: any = await db.run(
    `INSERT INTO strategies (
      name,
      api_key_id,
      strategy_type,
      market_mode,
      is_active,
      display_on_chart,
      show_settings,
      show_chart,
      show_indicators,
      show_positions_on_chart,
      show_values_each_bar,
      auto_update,
      take_profit_percent,
      price_channel_length,
      detection_source,
      base_symbol,
      quote_symbol,
      interval,
      base_coef,
      quote_coef,
      long_enabled,
      short_enabled,
      lot_long_percent,
      lot_short_percent,
      max_deposit,
      margin_type,
      leverage,
      fixed_lot,
      reinvest_percent,
      state,
      entry_ratio,
      last_signal,
      last_action,
      last_error,
      show_trades_on_chart,
      tp_anchor_ratio,
      zscore_entry,
      zscore_exit,
      zscore_stop,
      is_runtime,
      is_archived,
      origin,
      created_at,
      updated_at
    ) VALUES (
      ?, ?,
      ?, ?,
      1, 1, 1, 1, 1, 1, 0, 1,
      7.5, 50, 'close',
      ?, ?, ?,
      ?, ?,
      1, 1,
      10, 10, 1000,
      'cross', 1, 0, 0,
      ?, NULL, ?, ?, NULL,
      0, NULL,
      2.0, 0.5, 3.5,
      ?, ?, ?,
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    )`,
    [
      strategyName,
      apiKeyId,
      String(payload.strategy_type || 'DD_BattleToads'),
      String(payload.market_mode || 'mono') === 'synthetic' ? 'synthetic' : 'mono',
      String(payload.base_symbol || 'BTCUSDT').toUpperCase(),
      String(payload.quote_symbol || '').toUpperCase(),
      String(payload.interval || '4h'),
      Number(payload.base_coef ?? 1),
      Number(payload.quote_coef ?? 0),
      String(payload.state || 'flat'),
      payload.last_signal ?? null,
      payload.last_action ?? null,
      Number(payload.is_runtime ?? 1) ? 1 : 0,
      Number(payload.is_archived ?? 0) ? 1 : 0,
      String(payload.origin || 'runtime_cucumber'),
    ]
  );

  fixtureStrategyIds[fixtureName] = Number(insert?.lastID || 0);
  assert.ok(fixtureStrategyIds[fixtureName] > 0, `Failed to create fixture ${fixtureName}`);
});

When('I GET runtime summary for {string} with runtimeOnly {string}', async (apiKeyName: string, runtimeOnly: string) => {
  sharedState.response = await request(sharedState.app)
    .get(`/api/strategies/${encodeURIComponent(apiKeyName)}/summary?limit=500&offset=0&runtimeOnly=${encodeURIComponent(runtimeOnly)}&includeArchived=1`)
    .set('Authorization', authHeader());
});

When('I GET runtime detail for fixture {string} on {string}', async (fixtureName: string, apiKeyName: string) => {
  const strategyId = fixtureStrategyIds[fixtureName];
  assert.ok(strategyId > 0, `Unknown fixture: ${fixtureName}`);

  sharedState.response = await request(sharedState.app)
    .get(`/api/strategies/${encodeURIComponent(apiKeyName)}/${strategyId}`)
    .set('Authorization', authHeader());
});

When('I PUT runtime fixture {string} on {string} with body:', async (fixtureName: string, apiKeyName: string, rawBody: string) => {
  const strategyId = fixtureStrategyIds[fixtureName];
  assert.ok(strategyId > 0, `Unknown fixture: ${fixtureName}`);

  const body = parseJson(rawBody);
  sharedState.response = await request(sharedState.app)
    .put(`/api/strategies/${encodeURIComponent(apiKeyName)}/${strategyId}`)
    .set('Authorization', authHeader())
    .send(body);
});

When('I PUT runtime fixture {string} on {string} with mismatched body id by {int}', async (fixtureName: string, apiKeyName: string, delta: number) => {
  const strategyId = fixtureStrategyIds[fixtureName];
  assert.ok(strategyId > 0, `Unknown fixture: ${fixtureName}`);

  sharedState.response = await request(sharedState.app)
    .put(`/api/strategies/${encodeURIComponent(apiKeyName)}/${strategyId}`)
    .set('Authorization', authHeader())
    .send({ id: strategyId + Number(delta), name: `${fixtureName}_mismatch` });
});

When('I POST runtime strategy to {string} with body:', async (apiKeyName: string, rawBody: string) => {
  const body = parseJson(rawBody);

  sharedState.response = await request(sharedState.app)
    .post(`/api/strategies/${encodeURIComponent(apiKeyName)}`)
    .set('Authorization', authHeader())
    .send(body);

  if (sharedState.response?.body && typeof sharedState.response.body === 'object') {
    lastPostedStrategy = sharedState.response.body as Record<string, unknown>;
  } else {
    lastPostedStrategy = null;
  }
});

Then('runtime summary should include fixture {string} with state {string}', (fixtureName: string, expectedState: string) => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const list = Array.isArray(sharedState.response!.body) ? sharedState.response!.body : [];
  const strategyId = fixtureStrategyIds[fixtureName];
  assert.ok(strategyId > 0, `Unknown fixture: ${fixtureName}`);

  const found = list.find((row: any) => Number(row?.id || 0) === strategyId);
  assert.ok(found, `Fixture ${fixtureName} (id=${strategyId}) not found in summary`);
  assert.strictEqual(String(found.state || '').toLowerCase(), String(expectedState).toLowerCase());
});

Then('runtime detail for fixture {string} should have state {string} and signal {string}', (fixtureName: string, expectedState: string, expectedSignal: string) => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const body = sharedState.response!.body || {};
  const strategyId = fixtureStrategyIds[fixtureName];

  assert.strictEqual(Number(body.id || 0), strategyId, 'Unexpected strategy detail id');
  assert.strictEqual(String(body.state || '').toLowerCase(), String(expectedState).toLowerCase());
  assert.strictEqual(String(body.last_signal || '').toLowerCase(), String(expectedSignal).toLowerCase());
});

Then('runtime detail for fixture {string} should keep base {string} quote {string} interval {string}', (fixtureName: string, base: string, quote: string, interval: string) => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const body = sharedState.response!.body || {};

  assert.strictEqual(String(body.base_symbol || '').toUpperCase(), String(base || '').toUpperCase());
  assert.strictEqual(String(body.quote_symbol || '').toUpperCase(), String(quote || '').toUpperCase());
  assert.strictEqual(String(body.interval || ''), String(interval || ''));

  const strategyId = fixtureStrategyIds[fixtureName];
  assert.strictEqual(Number(body.id || 0), strategyId, 'Unexpected strategy detail id after atomic update test');
});

Then('runtime created strategy should have quote_coef equal to {int}', (expected: number) => {
  assert.ok(lastPostedStrategy, 'Expected previously posted strategy payload');
  const quoteCoef = Number((lastPostedStrategy as Record<string, unknown>).quote_coef);
  assert.ok(Number.isFinite(quoteCoef), `quote_coef must be numeric, got: ${String((lastPostedStrategy as Record<string, unknown>).quote_coef)}`);
  assert.strictEqual(quoteCoef, Number(expected));
});

import assert from 'assert';
import request, { Response } from 'supertest';
import { Before, Given, Then, When } from '@cucumber/cucumber';

const apiSteps = require('./api.steps');
const sharedState: {
  app: import('express').Express;
  response: Response | null;
} = apiSteps.sharedState;

type ApiKeyRef = {
  id: number;
  name: string;
};

type ClientLifecycleState = {
  token: string;
  aliases: Record<string, ApiKeyRef>;
};

const state: ClientLifecycleState = {
  token: '',
  aliases: {},
};

const app = () => request(sharedState.app);

const authHeader = () => ({ Authorization: `Bearer ${state.token}` });

const resolveAlias = (alias: string): ApiKeyRef => {
  const apiKey = state.aliases[alias];
  assert.ok(apiKey, `Unknown API key alias: ${alias}`);
  return apiKey;
};

const getKeysFromLastResponse = (): Array<Record<string, unknown>> => {
  assert.ok(sharedState.response, 'Expected response to be set');
  const keys = sharedState.response?.body?.keys;
  assert.ok(Array.isArray(keys), 'Expected response.body.keys to be an array');
  return keys as Array<Record<string, unknown>>;
};

Before(() => {
  state.token = '';
  state.aliases = {};
});

Given('an authenticated dual-mode client workspace', async () => {
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const response = await app()
    .post('/api/auth/client/register')
    .send({
      email: `client-${nonce}@example.com`,
      password: 'VerySecure12345',
      fullName: `Client ${nonce}`,
      companyName: `Workspace ${nonce}`,
      preferredLanguage: 'ru',
      productMode: 'dual',
    });

  sharedState.response = response;
  assert.strictEqual(response.status, 200, response.text || 'Client registration failed');
  state.token = String(response.body?.token || '');
  assert.ok(state.token, 'Expected auth token from client registration');
});

When('the client creates API key {string}', async (alias: string) => {
  const createResponse = await app()
    .post('/api/client/api-key')
    .set(authHeader())
    .send({
      exchange: 'bybit',
      apiKey: `api-${alias}-${Date.now()}`,
      secret: `secret-${alias}-${Date.now()}`,
      testnet: true,
      demo: false,
    });

  sharedState.response = createResponse;
  assert.strictEqual(createResponse.status, 200, createResponse.text || 'API key creation failed');

  const keyName = String(createResponse.body?.keyName || '').trim();
  assert.ok(keyName, 'Expected keyName in API key creation response');

  const listResponse = await app()
    .get('/api/client/api-keys')
    .set(authHeader());

  assert.strictEqual(listResponse.status, 200, listResponse.text || 'API key listing failed after creation');
  const row = (Array.isArray(listResponse.body?.keys) ? listResponse.body.keys : []).find(
    (item: Record<string, unknown>) => String(item?.name || '') === keyName,
  ) as Record<string, unknown> | undefined;

  assert.ok(row, `Expected created API key ${keyName} in list response`);
  state.aliases[alias] = {
    id: Number(row?.id || 0),
    name: keyName,
  };
});

When('the client lists API keys', async () => {
  sharedState.response = await app()
    .get('/api/client/api-keys')
    .set(authHeader());
});

When('the client saves strategy profile with API key {string} and requestedEnabled {string}', async (alias: string, requestedEnabled: string) => {
  const apiKey = resolveAlias(alias);
  sharedState.response = await app()
    .patch('/api/client/strategy/profile')
    .set(authHeader())
    .send({
      selectedOfferIds: [],
      assignedApiKeyName: apiKey.name,
      requestedEnabled: requestedEnabled === 'true',
    });
});

When('the client saves algofund profile with API key {string}', async (alias: string) => {
  const apiKey = resolveAlias(alias);
  sharedState.response = await app()
    .patch('/api/client/algofund/profile')
    .set(authHeader())
    .send({
      riskMultiplier: 1,
      assignedApiKeyName: apiKey.name,
    });
});

When('the client deletes API key {string}', async (alias: string) => {
  const apiKey = resolveAlias(alias);
  sharedState.response = await app()
    .delete(`/api/client/api-keys/${apiKey.id}`)
    .set(authHeader());
});

Then('the API key list should contain {int} keys', (count: number) => {
  const keys = getKeysFromLastResponse();
  assert.strictEqual(keys.length, count, `Expected ${count} API keys, got ${keys.length}`);
});

Then('API key {string} should not be assigned to any client flow', (alias: string) => {
  const apiKey = resolveAlias(alias);
  const row = getKeysFromLastResponse().find((item) => String(item.name || '') === apiKey.name);
  assert.ok(row, `Expected API key ${apiKey.name} in response`);
  assert.strictEqual(Boolean(row?.usedByStrategy), false, 'Expected key not used by strategy');
  assert.strictEqual(Boolean(row?.usedByAlgofund), false, 'Expected key not used by algofund');
  assert.strictEqual(Boolean(row?.usedByCustomTs), false, 'Expected key not used by custom TS');
});

Then('API key {string} should be marked for strategy usage', (alias: string) => {
  const apiKey = resolveAlias(alias);
  const row = getKeysFromLastResponse().find((item) => String(item.name || '') === apiKey.name);
  assert.ok(row, `Expected API key ${apiKey.name} in response`);
  assert.strictEqual(Boolean(row?.usedByStrategy), true, 'Expected key to be marked for strategy usage');
});

Then('API key {string} should be marked for algofund usage', (alias: string) => {
  const apiKey = resolveAlias(alias);
  const row = getKeysFromLastResponse().find((item) => String(item.name || '') === apiKey.name);
  assert.ok(row, `Expected API key ${apiKey.name} in response`);
  assert.strictEqual(Boolean(row?.usedByAlgofund), true, 'Expected key to be marked for algofund usage');
});

Then('the strategy API assignment should be empty', () => {
  assert.ok(sharedState.response, 'Expected response to be set');
  assert.strictEqual(String(sharedState.response?.body?.strategyAssignedApiKeyName || ''), '', 'Expected empty strategyAssignedApiKeyName');
});
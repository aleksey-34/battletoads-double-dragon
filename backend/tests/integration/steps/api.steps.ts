import assert from 'assert';
import path from 'path';
import os from 'os';
import fs from 'fs';
import express, { Express } from 'express';
import request, { Response } from 'supertest';
import { AfterAll, BeforeAll, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';
import routes from '../../../src/api/routes';
import { initDB } from '../../../src/utils/database';

type TestWorldState = {
  app: Express;
  response: Response | null;
  password: string;
  dbFile: string;
};

const state: TestWorldState = {
  app: express(),
  response: null,
  password: 'defaultpassword',
  dbFile: '',
};

setDefaultTimeout(60 * 1000);

BeforeAll(async () => {
  state.dbFile = path.join(os.tmpdir(), `btdd-cucumber-${Date.now()}.sqlite`);
  process.env.DB_FILE = state.dbFile;
  process.env.ENABLE_GIT_UPDATE = '0';

  await initDB();

  state.app = express();
  state.app.use(express.json({ limit: '2mb' }));
  state.app.use('/api', routes);
});

AfterAll(async () => {
  if (state.dbFile && fs.existsSync(state.dbFile)) {
    try {
      fs.rmSync(state.dbFile, { force: true });
    } catch {
      // Ignore temp db cleanup issues; they should not fail test outcomes.
    }
  }
});

Given('dashboard auth password is {string}', (password: string) => {
  state.password = password;
});

Given('git update feature is disabled', () => {
  process.env.ENABLE_GIT_UPDATE = '0';
});

When('I send a {string} request to {string} without auth', async (method: string, routePath: string) => {
  const req = request(state.app);
  const normalizedMethod = method.toLowerCase();

  if (normalizedMethod === 'get') {
    state.response = await req.get(routePath);
    return;
  }

  if (normalizedMethod === 'post') {
    state.response = await req.post(routePath).send({});
    return;
  }

  throw new Error(`Unsupported method without auth: ${method}`);
});

When('I send a {string} request to {string} with auth', async (method: string, routePath: string) => {
  const req = request(state.app);
  const normalizedMethod = method.toLowerCase();
  const authHeader = `Bearer ${state.password}`;

  if (normalizedMethod === 'get') {
    state.response = await req.get(routePath).set('Authorization', authHeader);
    return;
  }

  if (normalizedMethod === 'post') {
    state.response = await req.post(routePath).set('Authorization', authHeader).send({});
    return;
  }

  throw new Error(`Unsupported method with auth: ${method}`);
});

Then('the response status should be {int}', (statusCode: number) => {
  assert.ok(state.response, 'Expected response to be set');
  assert.strictEqual(state.response!.status, statusCode, state.response!.text || 'Unexpected status');
});

Then('the response JSON should include key {string}', (key: string) => {
  assert.ok(state.response, 'Expected response to be set');
  assert.ok(state.response!.body && typeof state.response!.body === 'object', 'Expected JSON body');
  assert.ok(Object.prototype.hasOwnProperty.call(state.response!.body, key), `Expected key: ${key}`);
});

Then('the response error should contain {string}', (text: string) => {
  assert.ok(state.response, 'Expected response to be set');
  const errorText = String(state.response!.body?.error || state.response!.text || '');
  assert.ok(errorText.toLowerCase().includes(text.toLowerCase()), `Expected error to contain: ${text}; got: ${errorText}`);
});

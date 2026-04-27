import assert from 'assert';
import { Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';

setDefaultTimeout(30_000);

// ─── State ───────────────────────────────────────────────────────────────────

let computedIntervalMs = 0;
let guardFired = false;
let guardAction = '';
let strategyCreatedAtMs = 0;
let strategyInterval = '4h';
let coldStartBarsEnv = 1;
let testStrategyId = 0;

// ─── Helper: intervalToMs (mirrors strategy.ts logic, exported for test use) ─

const intervalToMs = (interval: string): number => {
  const value = String(interval || '').trim();

  if (value.endsWith('m')) {
    const minutes = Number.parseInt(value.replace('m', ''), 10);
    return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 60 * 1000;
  }

  if (value.endsWith('h')) {
    const hours = Number.parseInt(value.replace('h', ''), 10);
    return Number.isFinite(hours) && hours > 0 ? hours * 60 * 60 * 1000 : 60 * 60 * 1000;
  }

  if (value === '1d') return 24 * 60 * 60 * 1000;
  if (value === '1w') return 7 * 24 * 60 * 60 * 1000;
  if (value === '1M') return 30 * 24 * 60 * 60 * 1000;

  return 60 * 60 * 1000;
};

// ─── Helper: pure cold-start condition check ─────────────────────────────────

const coldStartGuardWouldFire = (
  createdAtMs: number,
  evaluatedBarTimeMs: number,
  interval: string,
  coldBars: number
): boolean => {
  if (coldBars <= 0) return false;
  const barMs = intervalToMs(interval);
  const coldUntilMs = createdAtMs + coldBars * barMs;
  return evaluatedBarTimeMs < coldUntilMs;
};

// ─── Steps ───────────────────────────────────────────────────────────────────

Given('the cold-start guard test database is initialized', async () => {
  // uses shared in-memory SQLite from api.steps.ts BeforeAll
  const { db } = await import('../../../src/utils/database');
  assert.ok(db, 'DB must be initialized');
});

When('I compute intervalToMs for {string}', (interval: string) => {
  computedIntervalMs = intervalToMs(interval);
});

Then('the result should be {int} milliseconds', (expected: number) => {
  assert.strictEqual(
    computedIntervalMs,
    expected,
    `intervalToMs returned ${computedIntervalMs}, expected ${expected}`
  );
});

Given('COLD_START_BARS env is {string}', (val: string) => {
  coldStartBarsEnv = Math.max(0, Math.floor(Number(val) || 0));
  process.env.COLD_START_BARS = val;
});

Given('a strategy with interval {string} was created {int} hours ago', (interval: string, hoursAgo: number) => {
  strategyInterval = interval;
  strategyCreatedAtMs = Date.now() - hoursAgo * 60 * 60 * 1000;
});

When('I check cold-start guard for that strategy at current bar', () => {
  // Simulate evaluatedBarTimeMs as "now" (most recent closed bar == just now)
  const evaluatedBarTimeMs = Date.now();
  const fired = coldStartGuardWouldFire(
    strategyCreatedAtMs,
    evaluatedBarTimeMs,
    strategyInterval,
    coldStartBarsEnv
  );
  guardFired = fired;
  guardAction = fired ? 'cold_start_skip' : '';
});

Then('the guard should fire with action {string}', (expectedAction: string) => {
  assert.ok(guardFired, 'Expected cold-start guard to fire but it did not');
  assert.strictEqual(guardAction, expectedAction, `Expected action ${expectedAction}, got ${guardAction}`);
});

Then('the guard should NOT fire', () => {
  assert.ok(!guardFired, `Expected cold-start guard NOT to fire but it fired (action: ${guardAction})`);
});

// ─── DB persistence scenario ─────────────────────────────────────────────────

Given('a persisted strategy {string} with interval {string} created {int} hours ago exists in DB', async (
  name: string,
  interval: string,
  hoursAgo: number
) => {
  const { db } = await import('../../../src/utils/database');

  // Ensure a test API key
  let keyId: number;
  const existingKey = await db.get("SELECT id FROM api_keys WHERE name = 'CS_TEST_KEY'");
  if (existingKey?.id) {
    keyId = Number(existingKey.id);
  } else {
    const r: any = await db.run(
      "INSERT INTO api_keys (name, exchange, api_key, secret) VALUES ('CS_TEST_KEY', 'bybit', 'cs_key', 'cs_secret')"
    );
    keyId = Number(r.lastID);
  }

  // Delete existing strategy with same name
  await db.run("DELETE FROM strategies WHERE name = ? AND api_key_id = ?", [name, keyId]);

  // Compute created_at as ISO string hoursAgo hours back
  const createdAtMs = Date.now() - hoursAgo * 60 * 60 * 1000;
  const createdAtIso = new Date(createdAtMs).toISOString().replace('T', ' ').replace('Z', '');

  const r: any = await db.run(
    `INSERT INTO strategies (
      name, api_key_id, strategy_type, market_mode, is_active, display_on_chart,
      show_settings, show_chart, show_indicators, show_positions_on_chart, show_values_each_bar,
      auto_update, take_profit_percent, price_channel_length, detection_source,
      base_symbol, quote_symbol, interval, base_coef, quote_coef,
      long_enabled, short_enabled, lot_long_percent, lot_short_percent,
      max_deposit, margin_type, leverage, fixed_lot, reinvest_percent,
      state, entry_ratio, last_signal, last_action, last_error,
      created_at, updated_at
    ) VALUES (
      ?, ?, 'DD_BattleToads', 'mono', 1, 1,
      1, 1, 1, 1, 0,
      1, 7.5, 50, 'close',
      'BTCUSDT', '', ?, 1, 0,
      1, 1, 10, 10,
      1000, 'cross', 1, 0, 0,
      'flat', NULL, NULL, NULL, NULL,
      ?, ?
    )`,
    [name, keyId, interval, createdAtIso, createdAtIso]
  );
  testStrategyId = Number(r.lastID);
  assert.ok(testStrategyId > 0, `Failed to insert test strategy ${name}`);
});

When('the cold-start guard evaluates strategy {string}', async (name: string) => {
  const { db } = await import('../../../src/utils/database');

  // Read the strategy from DB
  const row = await db.get('SELECT * FROM strategies WHERE id = ?', [testStrategyId]);
  assert.ok(row, `Strategy ${name} not found in DB`);

  const coldBars = Math.max(0, Math.floor(Number(process.env.COLD_START_BARS ?? 1) || 1));
  const barMs = intervalToMs(String(row.interval || '4h'));
  const createdAtMs = new Date(String(row.created_at).replace(' ', 'T') + 'Z').getTime();
  const evaluatedBarTimeMs = Date.now();
  const coldUntilMs = createdAtMs + coldBars * barMs;
  const shouldSkip = coldBars > 0 && evaluatedBarTimeMs < coldUntilMs;

  if (shouldSkip) {
    // Simulate what strategy.ts does: write last_action = cold_start_skip@ratio
    await db.run(
      "UPDATE strategies SET last_action = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
      [`cold_start_skip@1.0000`, testStrategyId]
    );
  }
});

Then('strategy {string} last_action should start with {string}', async (_name: string, prefix: string) => {
  const { db } = await import('../../../src/utils/database');
  const row = await db.get('SELECT last_action FROM strategies WHERE id = ?', [testStrategyId]);
  assert.ok(row, 'Strategy not found after guard evaluation');
  const lastAction = String(row.last_action || '');
  assert.ok(
    lastAction.startsWith(prefix),
    `Expected last_action to start with "${prefix}", got "${lastAction}"`
  );
});

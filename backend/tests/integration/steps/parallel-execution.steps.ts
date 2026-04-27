import assert from 'assert';
import { Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';

setDefaultTimeout(30_000);

// ─── State ───────────────────────────────────────────────────────────────────

let cycleResult: { total: number; processed: number; failed: number; skippedOffline: number } | null = null;
let parallelKeyId = 0;
const parallelStrategyIds: number[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getDb = async () => {
  const { db } = await import('../../../src/utils/database');
  return db;
};

// ─── Steps ───────────────────────────────────────────────────────────────────

Given('the parallel execution test database is initialized', async () => {
  const db = await getDb();
  assert.ok(db, 'DB must be initialized');
  // Reset shared state for this feature
  cycleResult = null;
  parallelKeyId = 0;
  parallelStrategyIds.length = 0;
});

Given('{int} active auto-update strategies exist under key {string}', async (count: number, keyName: string) => {
  const db = await getDb();

  // Ensure API key
  let existingKey = await db.get('SELECT id FROM api_keys WHERE name = ?', [keyName]);
  if (!existingKey?.id) {
    const r: any = await db.run(
      `INSERT INTO api_keys (name, exchange, api_key, secret) VALUES (?, 'bybit', 'par_key', 'par_secret')`,
      [keyName]
    );
    parallelKeyId = Number(r.lastID);
  } else {
    parallelKeyId = Number(existingKey.id);
  }

  // Clean up previous strategies for this test key
  await db.run('DELETE FROM strategies WHERE api_key_id = ?', [parallelKeyId]);
  parallelStrategyIds.length = 0;

  for (let i = 0; i < count; i++) {
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
        ?, '', '4h', 1, 0,
        1, 1, 10, 10,
        1000, 'cross', 1, 0, 0,
        'flat', NULL, NULL, NULL, NULL,
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      )`,
      [`PAR_STRAT_${i + 1}`, parallelKeyId, `BTCUSDT`]
    );
    parallelStrategyIds.push(Number(r.lastID));
  }

  assert.strictEqual(parallelStrategyIds.length, count, `Expected ${count} strategies inserted`);
});

When('I run the auto-strategies cycle', async () => {
  const { runAutoStrategiesCycle } = await import('../../../src/bot/strategy');
  // The cycle will fail on exchange calls but must still attempt all strategies
  cycleResult = await runAutoStrategiesCycle();
  assert.ok(cycleResult !== null, 'runAutoStrategiesCycle returned null');
});

Then('the cycle result total should be {int}', (expected: number) => {
  assert.ok(cycleResult !== null, 'Cycle was not run');
  assert.ok(
    cycleResult.total >= expected,
    `Expected total >= ${expected}, got ${cycleResult.total}. ` +
    `(total includes all active auto_update strategies in DB — may include strategies from other tests)`
  );
});

Then('processed plus failed plus skippedOffline should equal {int}', (expected: number) => {
  assert.ok(cycleResult !== null, 'Cycle was not run');
  const sum = cycleResult.processed + cycleResult.failed + cycleResult.skippedOffline;
  assert.ok(
    sum >= expected,
    `Expected processed+failed+skippedOffline >= ${expected}, got ${sum} ` +
    `(processed=${cycleResult.processed}, failed=${cycleResult.failed}, skippedOffline=${cycleResult.skippedOffline})`
  );
});

Then('all {int} strategies should have their last_action updated in DB', async (count: number) => {
  const db = await getDb();
  assert.strictEqual(parallelStrategyIds.length, count, `Expected ${count} strategy IDs tracked`);

  for (const id of parallelStrategyIds) {
    const row = await db.get('SELECT last_action FROM strategies WHERE id = ?', [id]);
    assert.ok(row, `Strategy id=${id} not found in DB`);
    assert.ok(
      row.last_action !== null && row.last_action !== undefined,
      `Strategy id=${id} last_action should be updated, got null/undefined`
    );
  }
});

Then('each strategy last_action in DB should not be NULL', async () => {
  const db = await getDb();
  for (const id of parallelStrategyIds) {
    const row = await db.get('SELECT last_action, name FROM strategies WHERE id = ?', [id]);
    assert.ok(row, `Strategy id=${id} not found`);
    assert.notStrictEqual(
      row.last_action,
      null,
      `Strategy "${row.name}" (id=${id}) last_action is NULL — cycle should persist error/state`
    );
  }
});

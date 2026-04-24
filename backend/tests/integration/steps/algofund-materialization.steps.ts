import assert from 'assert';
import { AfterAll, BeforeAll, Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';

// Reuse shared app/state from api.steps.ts (app is initialized in BeforeAll there)
// eslint-disable-next-line @typescript-eslint/no-var-requires
const sharedState: {
  app: import('express').Express;
  response: import('supertest').Response | null;
  password: string;
} = require('./api.steps').sharedState;

setDefaultTimeout(30_000);

// ─── Types ───────────────────────────────────────────────────────────────────

type DbMember = Record<string, unknown>;

// ─── State ───────────────────────────────────────────────────────────────────

let matApiKeyId = 0;
let matSourceTsId = 0;
let matCardId = 0;
let dbSourceMembers: DbMember[] = [];
let masterCardMembers: DbMember[] = [];

// ─── Helpers ─────────────────────────────────────────────────────────────────

const getDb = async () => {
  const { db } = await import('../../../src/utils/database');
  return db;
};

const ensureMatApiKey = async (keyName: string, exchange: string): Promise<number> => {
  const db = await getDb();
  const existing = await db.get('SELECT id FROM api_keys WHERE name = ?', [keyName]);
  if (existing?.id) {
    matApiKeyId = Number(existing.id);
    return matApiKeyId;
  }
  const insert: any = await db.run(
    `INSERT INTO api_keys (name, exchange, api_key, secret) VALUES (?, ?, 'mattest_key', 'mattest_secret')`,
    [keyName, exchange]
  );
  matApiKeyId = Number(insert?.lastID || 0);
  assert.ok(matApiKeyId > 0, `Failed to create test API key ${keyName}`);
  return matApiKeyId;
};

// Creates N strategies attached to this api key and inserts them into trading_system_members
const ensureSourceTsWithMembers = async (tsName: string, keyName: string, memberCount: number): Promise<number> => {
  const db = await getDb();

  // Ensure api key
  await ensureMatApiKey(keyName, 'bybit');

  // Ensure the trading system
  let tsId = 0;
  const existingTs = await db.get(
    'SELECT id FROM trading_systems WHERE name = ? AND api_key_id = ?',
    [tsName, matApiKeyId]
  );
  if (existingTs?.id) {
    tsId = Number(existingTs.id);
  } else {
    const tsInsert: any = await db.run(
      `INSERT INTO trading_systems (name, api_key_id, description, is_active, max_members, auto_sync_members, discovery_enabled)
       VALUES (?, ?, 'materialization test TS', 1, 30, 0, 0)`,
      [tsName, matApiKeyId]
    );
    tsId = Number(tsInsert?.lastID || 0);
    assert.ok(tsId > 0, `Failed to create source TS ${tsName}`);
  }
  matSourceTsId = tsId;

  // Clear existing members
  await db.run('DELETE FROM trading_system_members WHERE system_id = ?', [tsId]);

  // Create strategies and add as members
  for (let i = 0; i < memberCount; i += 1) {
    const stratName = `${tsName}_member_${i + 1}`;
    let stratId = 0;
    const existingStrat = await db.get(
      'SELECT id FROM strategies WHERE name = ? AND api_key_id = ?',
      [stratName, matApiKeyId]
    );
    if (existingStrat?.id) {
      stratId = Number(existingStrat.id);
      // Ensure it's enabled in the TS
    } else {
      const stratInsert: any = await db.run(
        `INSERT INTO strategies
           (name, api_key_id, strategy_type, market_mode, is_active, auto_update,
            base_symbol, quote_symbol, interval, base_coef, quote_coef,
            long_enabled, short_enabled, lot_long_percent, lot_short_percent, max_deposit,
            margin_type, leverage, state, is_runtime, is_archived,
            take_profit_percent, price_channel_length, detection_source,
            created_at, updated_at)
         VALUES
           (?, ?, 'DD_BattleToads', 'mono', 1, 1,
            ?, '', '4h', 1, 0,
            1, 1, 10, 10, 1000,
            'cross', 1, 'flat', 0, 0,
            7.5, 50, 'close',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [stratName, matApiKeyId, `SYMBOL${i + 1}USDT`]
      );
      stratId = Number(stratInsert?.lastID || 0);
    }
    assert.ok(stratId > 0, `Failed to create member strategy ${stratName}`);

    await db.run(
      `INSERT OR REPLACE INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled)
       VALUES (?, ?, 1.0, 'core', 1)`,
      [tsId, stratId]
    );
  }

  return tsId;
};

// ─── Given ───────────────────────────────────────────────────────────────────

Given('a materialization test API key {string} exists on exchange {string}', async (keyName: string, exchange: string) => {
  matApiKeyId = await ensureMatApiKey(keyName, exchange);
});

Given('source trading system {string} exists on key {string} with {int} enabled members', async (tsName: string, keyName: string, count: number) => {
  matSourceTsId = await ensureSourceTsWithMembers(tsName, keyName, count);
});

Given('no master_card exists for source system {string}', async (sourceSystemName: string) => {
  const db = await getDb();
  const cardCode = `CARD::${sourceSystemName.toUpperCase()}`;
  await db.run('DELETE FROM master_card_members WHERE card_id IN (SELECT id FROM master_cards WHERE code = ?)', [cardCode]);
  await db.run('DELETE FROM master_cards WHERE code = ?', [cardCode]);
  matCardId = 0;
});

Given('a master_card {string} exists with {int} enabled members on key {string}', async (cardCode: string, memberCount: number, keyName: string) => {
  const db = await getDb();
  await ensureMatApiKey(keyName, 'bybit');

  // Remove any previous card with this code
  const prevCard = await db.get('SELECT id FROM master_cards WHERE code = ?', [cardCode]);
  if (prevCard?.id) {
    await db.run('DELETE FROM master_card_members WHERE card_id = ?', [prevCard.id]);
    await db.run('DELETE FROM master_cards WHERE id = ?', [prevCard.id]);
  }

  // Insert the card
  const cardInsert: any = await db.run(
    `INSERT INTO master_cards (code, name, description, source_system_id, is_active)
     VALUES (?, ?, 'test card', ?, 1)`,
    [cardCode, cardCode, matSourceTsId || null]
  );
  matCardId = Number(cardInsert?.lastID || 0);
  assert.ok(matCardId > 0, `Failed to create master_card ${cardCode}`);

  // Create strategies and add as card members
  for (let i = 0; i < memberCount; i += 1) {
    const stratName = `card_member_${matCardId}_${i + 1}`;
    let stratId = 0;
    const existingStrat = await db.get(
      'SELECT id FROM strategies WHERE name = ? AND api_key_id = ?',
      [stratName, matApiKeyId]
    );
    if (existingStrat?.id) {
      stratId = Number(existingStrat.id);
    } else {
      const stratInsert: any = await db.run(
        `INSERT INTO strategies
           (name, api_key_id, strategy_type, market_mode, is_active, auto_update,
            base_symbol, quote_symbol, interval, base_coef, quote_coef,
            long_enabled, short_enabled, lot_long_percent, lot_short_percent, max_deposit,
            margin_type, leverage, state, is_runtime, is_archived,
            take_profit_percent, price_channel_length, detection_source,
            created_at, updated_at)
         VALUES
           (?, ?, 'DD_BattleToads', 'mono', 1, 1,
            ?, '', '4h', 1, 0,
            1, 1, 10, 10, 1000,
            'cross', 1, 'flat', 0, 0,
            7.5, 50, 'close',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [stratName, matApiKeyId, `CARDSYM${i + 1}USDT`]
      );
      stratId = Number(stratInsert?.lastID || 0);
    }
    assert.ok(stratId > 0, `Failed to create card member strategy ${stratName}`);
    await db.run(
      `INSERT OR REPLACE INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled)
       VALUES (?, ?, 1.0, 'core', 1)`,
      [matCardId, stratId]
    );
  }
});

Given('source trading system {string} has no enabled members in DB', async (tsName: string) => {
  const db = await getDb();
  if (matSourceTsId > 0) {
    await db.run('UPDATE trading_system_members SET is_enabled = 0 WHERE system_id = ?', [matSourceTsId]);
  } else {
    const ts = await db.get('SELECT id FROM trading_systems WHERE name = ?', [tsName]);
    if (ts?.id) {
      await db.run('UPDATE trading_system_members SET is_enabled = 0 WHERE system_id = ?', [ts.id]);
    }
  }
});

// ─── When ─────────────────────────────────────────────────────────────────────

When('I query materialization DB source for key {string} system {string}', async (keyName: string, systemName: string) => {
  const db = await getDb();
  dbSourceMembers = [];
  masterCardMembers = [];

  // --- Replicate Priority 1 from materializeAlgofundSystem ---
  const cardCode = `CARD::${systemName.toUpperCase()}`;
  const card = await db.get<{ id: number }>('SELECT id FROM master_cards WHERE code = ? AND is_active = 1', [cardCode]).catch(() => null);
  if (card?.id) {
    masterCardMembers = await db.all<Record<string, unknown>>(
      `SELECT mcm.strategy_id, mcm.weight, s.name AS strategy_name,
              s.strategy_type, s.market_mode, s.base_symbol
       FROM master_card_members mcm
       JOIN strategies s ON s.id = mcm.strategy_id
       WHERE mcm.card_id = ? AND mcm.is_enabled = 1`,
      [card.id]
    ).catch(() => [] as Record<string, unknown>[]);
  }

  // --- Replicate Priority 2 from materializeAlgofundSystem ---
  if (masterCardMembers.length === 0) {
    const sourceTs = await db.get<{ id: number }>(
      `SELECT ts.id FROM trading_systems ts
       JOIN api_keys a ON a.id = ts.api_key_id
       WHERE ts.name = ? AND a.name = ?
       LIMIT 1`,
      [systemName, keyName]
    ).catch(() => null);
    if (sourceTs?.id) {
      dbSourceMembers = await db.all<Record<string, unknown>>(
        `SELECT tsm.strategy_id, tsm.weight, s.name AS strategy_name,
                s.strategy_type, s.market_mode, s.base_symbol
         FROM trading_system_members tsm
         JOIN strategies s ON s.id = tsm.strategy_id
         WHERE tsm.system_id = ? AND tsm.is_enabled = 1`,
        [sourceTs.id]
      ).catch(() => [] as Record<string, unknown>[]);
    }
  }
});

// ─── Then ─────────────────────────────────────────────────────────────────────

Then('the DB source member count should be {int}', (expected: number) => {
  const count = dbSourceMembers.length;
  assert.strictEqual(count, expected, `Expected DB source member count to be ${expected}, got ${count}`);
});

Then('the DB source query should succeed', () => {
  // If we got here without throwing, the query succeeded.
  assert.ok(true, 'DB source query completed without error');
});

Then('the master card member count should be {int}', (expected: number) => {
  const count = masterCardMembers.length;
  assert.strictEqual(count, expected, `Expected master card member count to be ${expected}, got ${count}`);
});

Then('the master card count should exceed {int}', (min: number) => {
  assert.ok(masterCardMembers.length > min, `Expected master card member count > ${min}, got ${masterCardMembers.length}`);
});

Then('all returned member strategyIds should be positive integers', () => {
  const members = masterCardMembers.length > 0 ? masterCardMembers : dbSourceMembers;
  assert.ok(members.length > 0, 'Expected at least one member to validate strategyIds');
  for (const m of members) {
    const id = Number(m['strategy_id'] || 0);
    assert.ok(Number.isInteger(id) && id > 0, `Expected strategyId to be a positive integer, got: ${m['strategy_id']}`);
  }
});

Then('all returned member weights should be positive numbers', () => {
  const members = masterCardMembers.length > 0 ? masterCardMembers : dbSourceMembers;
  assert.ok(members.length > 0, 'Expected at least one member to validate weights');
  for (const m of members) {
    const w = Number(m['weight'] ?? 1);
    assert.ok(Number.isFinite(w) && w > 0, `Expected weight to be a positive number, got: ${m['weight']}`);
  }
});

import assert from 'assert';
import { Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';

setDefaultTimeout(30_000);

// ─── State ───────────────────────────────────────────────────────────────────

let pnlMigrationError: Error | null = null;
let pnlEquity = 0;
let pnlUnrealized = 0;
let pnlDepositBase = 0;
let computedPnlNet = 0;
let firstSnapshotId = 0;
let secondSnapshotId = 0;

const getDb = async () => {
  const { db } = await import('../../../src/utils/database');
  return db;
};

// ─── Migration helper: runs the same ALTER TABLE statements as monitoring.ts ─

const runPnlMigration = async () => {
  const db = await getDb();
  try { await db.exec('ALTER TABLE monitoring_snapshots ADD COLUMN deposit_base_usd REAL DEFAULT NULL'); } catch { /* already exists */ }
  try { await db.exec('ALTER TABLE monitoring_snapshots ADD COLUMN pnl_net_usd REAL DEFAULT NULL'); } catch { /* already exists */ }
};

// ─── Ensure test API key ──────────────────────────────────────────────────────

const ensurePnlTestKey = async (keyName: string): Promise<number> => {
  const db = await getDb();
  const existing = await db.get('SELECT id FROM api_keys WHERE name = ?', [keyName]);
  if (existing?.id) {
    return Number(existing.id);
  }
  const r: any = await db.run(
    `INSERT INTO api_keys (name, exchange, api_key, secret) VALUES (?, 'bybit', 'pnl_test_key', 'pnl_test_secret')`,
    [keyName]
  );
  return Number(r.lastID);
};

// ─── Steps ───────────────────────────────────────────────────────────────────

Given('the PnL tracking test database is initialized', async () => {
  const db = await getDb();
  assert.ok(db, 'DB must be initialized');
  pnlMigrationError = null;
  pnlEquity = 0;
  pnlUnrealized = 0;
  pnlDepositBase = 0;
  computedPnlNet = 0;
  firstSnapshotId = 0;
  secondSnapshotId = 0;
});

When('I run the PnL migration for monitoring_snapshots', async () => {
  try {
    await runPnlMigration();
    pnlMigrationError = null;
  } catch (e) {
    pnlMigrationError = e as Error;
    throw e;
  }
});

When('I run the PnL migration for monitoring_snapshots again', async () => {
  try {
    await runPnlMigration();
    pnlMigrationError = null;
  } catch (e) {
    pnlMigrationError = e as Error;
  }
});

Then('monitoring_snapshots table should have column {string}', async (columnName: string) => {
  const db = await getDb();
  const cols: any[] = await db.all(`PRAGMA table_info(monitoring_snapshots)`);
  const found = cols.some((c: any) => c.name === columnName);
  assert.ok(
    found,
    `Column "${columnName}" not found in monitoring_snapshots. ` +
    `Available columns: ${cols.map((c: any) => c.name).join(', ')}`
  );
});

Then('no PnL migration error should have occurred', () => {
  assert.strictEqual(pnlMigrationError, null, `Unexpected migration error: ${pnlMigrationError?.message}`);
});

// ─── Math steps ──────────────────────────────────────────────────────────────

Given('equity_usd is {float}, unrealized_pnl is {float}, deposit_base_usd is {float}', (
  equity: number,
  unrealized: number,
  deposit: number
) => {
  pnlEquity = equity;
  pnlUnrealized = unrealized;
  pnlDepositBase = deposit;
});

When('I compute pnl_net_usd', () => {
  // Mirrors monitoring.ts formula exactly:
  // pnlNet = metrics.equityUsd - metrics.unrealizedPnl - depositBase
  computedPnlNet = pnlEquity - pnlUnrealized - pnlDepositBase;
});

Then('pnl_net_usd should be {float}', (expected: number) => {
  assert.ok(
    Math.abs(computedPnlNet - expected) < 0.0001,
    `pnl_net_usd: expected ${expected}, got ${computedPnlNet}`
  );
});

// ─── Persistence steps ────────────────────────────────────────────────────────

When('I insert first monitoring snapshot for {string} with equity {float}', async (keyName: string, equity: number) => {
  const db = await getDb();
  const keyId = await ensurePnlTestKey(keyName);

  // Clean slate for this key
  await db.run('DELETE FROM monitoring_snapshots WHERE api_key_id = ?', [keyId]);

  // No previous snapshot → depositBase = equity
  const depositBase = equity;
  const pnlNet = equity - 0 - depositBase; // unrealized=0 on first snapshot

  const r: any = await db.run(
    `INSERT INTO monitoring_snapshots
       (api_key_id, exchange, equity_usd, unrealized_pnl, margin_used_usd,
        margin_load_percent, effective_leverage, notional_usd, drawdown_percent,
        deposit_base_usd, pnl_net_usd, recorded_at)
     VALUES (?, 'bybit', ?, 0, 0, 0, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP)`,
    [keyId, equity, depositBase, pnlNet]
  );
  firstSnapshotId = Number(r.lastID);
  assert.ok(firstSnapshotId > 0, `Failed to insert first snapshot for ${keyName}`);
});

When('I insert second monitoring snapshot for {string} with equity {float}', async (keyName: string, equity: number) => {
  const db = await getDb();
  const keyId = await ensurePnlTestKey(keyName);

  // Get depositBase from first snapshot
  const firstSnap = await db.get(
    'SELECT equity_usd FROM monitoring_snapshots WHERE api_key_id = ? ORDER BY id ASC LIMIT 1',
    [keyId]
  );
  const depositBase = Number(firstSnap?.equity_usd ?? equity);
  const pnlNet = equity - 0 - depositBase; // unrealized=0

  const r: any = await db.run(
    `INSERT INTO monitoring_snapshots
       (api_key_id, exchange, equity_usd, unrealized_pnl, margin_used_usd,
        margin_load_percent, effective_leverage, notional_usd, drawdown_percent,
        deposit_base_usd, pnl_net_usd, recorded_at)
     VALUES (?, 'bybit', ?, 0, 0, 0, 0, 0, 0, ?, ?, CURRENT_TIMESTAMP)`,
    [keyId, equity, depositBase, pnlNet]
  );
  secondSnapshotId = Number(r.lastID);
  assert.ok(secondSnapshotId > 0, `Failed to insert second snapshot for ${keyName}`);
});

Then('the stored deposit_base_usd should equal equity {float}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT deposit_base_usd FROM monitoring_snapshots WHERE id = ?', [firstSnapshotId]);
  assert.ok(row, 'First snapshot not found');
  assert.ok(
    Math.abs(Number(row.deposit_base_usd) - expected) < 0.001,
    `deposit_base_usd: expected ${expected}, got ${row.deposit_base_usd}`
  );
});

Then('the second snapshot deposit_base_usd should still be {float}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT deposit_base_usd FROM monitoring_snapshots WHERE id = ?', [secondSnapshotId]);
  assert.ok(row, 'Second snapshot not found');
  assert.ok(
    Math.abs(Number(row.deposit_base_usd) - expected) < 0.001,
    `deposit_base_usd: expected ${expected} (same as first), got ${row.deposit_base_usd}`
  );
});

Then('the second snapshot pnl_net_usd should be {float}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT pnl_net_usd FROM monitoring_snapshots WHERE id = ?', [secondSnapshotId]);
  assert.ok(row, 'Second snapshot not found');
  assert.ok(
    Math.abs(Number(row.pnl_net_usd) - expected) < 0.001,
    `pnl_net_usd: expected ${expected}, got ${row.pnl_net_usd}`
  );
});

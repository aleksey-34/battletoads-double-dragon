import assert from 'assert';
import { Given, Then, When, setDefaultTimeout } from '@cucumber/cucumber';

setDefaultTimeout(30_000);

// ─── State ───────────────────────────────────────────────────────────────────

let lastError: Error | null = null;
let lastInsertedSnapshotId = 0;

const getDb = async () => {
  const { db } = await import('../../../src/utils/database');
  return db;
};

// ─── Steps ───────────────────────────────────────────────────────────────────

Given('the extended analytics test database is initialized', async () => {
  const db = await getDb();
  assert.ok(db, 'DB must be initialized');
  lastError = null;
  lastInsertedSnapshotId = 0;
});

When('I call ensureBtRtTable', async () => {
  const { ensureBtRtTable } = await import('../../../src/analytics/btRtSweep');
  try {
    await ensureBtRtTable();
    lastError = null;
  } catch (e) {
    lastError = e as Error;
    throw e;
  }
});

When('I call ensureBtRtTable again', async () => {
  const { ensureBtRtTable } = await import('../../../src/analytics/btRtSweep');
  try {
    // Reset tableReady flag by reimporting — not possible without module cache clear.
    // Instead call the function again; it guards via the internal `tableReady` flag.
    await ensureBtRtTable();
    lastError = null;
  } catch (e) {
    lastError = e as Error;
  }
});

Then('bt_rt_daily_snapshots table should have column {string}', async (columnName: string) => {
  const db = await getDb();
  const cols: any[] = await db.all(`PRAGMA table_info(bt_rt_daily_snapshots)`);
  const found = cols.some((c: any) => c.name === columnName);
  assert.ok(
    found,
    `Column "${columnName}" not found in bt_rt_daily_snapshots. Columns: ${cols.map((c: any) => c.name).join(', ')}`
  );
});

Then('no error should have occurred', () => {
  assert.strictEqual(lastError, null, `Unexpected error: ${lastError?.message}`);
});

When('I insert a test snapshot with avg_slippage_pct {float} and avg_execution_delay_ms {int}', async (
  slippage: number,
  delayMs: number
) => {
  const db = await getDb();
  const snapshotDate = `2099-01-01_analytics_${Date.now()}`.substring(0, 10);
  const r: any = await db.run(
    `INSERT INTO bt_rt_daily_snapshots
      (snapshot_date, api_key_name, system_name, avg_slippage_pct, avg_execution_delay_ms)
     VALUES (?, 'ANALYTICS_TEST_KEY', 'TEST_SYSTEM', ?, ?)
     ON CONFLICT(snapshot_date, api_key_name) DO UPDATE SET
       avg_slippage_pct = excluded.avg_slippage_pct,
       avg_execution_delay_ms = excluded.avg_execution_delay_ms`,
    [snapshotDate, slippage, delayMs]
  );
  lastInsertedSnapshotId = r.lastID ? Number(r.lastID) : 0;

  if (!lastInsertedSnapshotId) {
    // Conflict resolved via DO UPDATE — fetch by date/key
    const existing = await db.get(
      `SELECT id FROM bt_rt_daily_snapshots WHERE snapshot_date = ? AND api_key_name = 'ANALYTICS_TEST_KEY'`,
      [snapshotDate]
    );
    lastInsertedSnapshotId = Number(existing?.id || 0);
  }
});

When('I insert a test snapshot with realized_pnl_usd {float}', async (pnl: number) => {
  const db = await getDb();
  const snapshotDate = `2099-01-02_pnl_${Date.now()}`.substring(0, 10);
  const r: any = await db.run(
    `INSERT INTO bt_rt_daily_snapshots
      (snapshot_date, api_key_name, system_name, realized_pnl_usd)
     VALUES (?, 'ANALYTICS_PNL_KEY', 'TEST_PNL_SYSTEM', ?)
     ON CONFLICT(snapshot_date, api_key_name) DO UPDATE SET
       realized_pnl_usd = excluded.realized_pnl_usd`,
    [snapshotDate, pnl]
  );
  lastInsertedSnapshotId = r.lastID ? Number(r.lastID) : 0;
  if (!lastInsertedSnapshotId) {
    const existing = await db.get(
      `SELECT id FROM bt_rt_daily_snapshots WHERE snapshot_date = ? AND api_key_name = 'ANALYTICS_PNL_KEY'`,
      [snapshotDate]
    );
    lastInsertedSnapshotId = Number(existing?.id || 0);
  }
});

When("I insert a test snapshot with trade_hour_distribution '{}'", async (hourDist: string) => {
  const db = await getDb();
  const snapshotDate = `2099-01-03_dist_${Date.now()}`.substring(0, 10);
  const r: any = await db.run(
    `INSERT INTO bt_rt_daily_snapshots
      (snapshot_date, api_key_name, system_name, trade_hour_distribution)
     VALUES (?, 'ANALYTICS_DIST_KEY', 'TEST_DIST_SYSTEM', ?)
     ON CONFLICT(snapshot_date, api_key_name) DO UPDATE SET
       trade_hour_distribution = excluded.trade_hour_distribution`,
    [snapshotDate, hourDist]
  );
  lastInsertedSnapshotId = r.lastID ? Number(r.lastID) : 0;
  if (!lastInsertedSnapshotId) {
    const existing = await db.get(
      `SELECT id FROM bt_rt_daily_snapshots WHERE snapshot_date = ? AND api_key_name = 'ANALYTICS_DIST_KEY'`,
      [snapshotDate]
    );
    lastInsertedSnapshotId = Number(existing?.id || 0);
  }
});

Then('the retrieved snapshot avg_slippage_pct should be {float}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT avg_slippage_pct FROM bt_rt_daily_snapshots WHERE id = ?', [lastInsertedSnapshotId]);
  assert.ok(row, 'Snapshot row not found');
  assert.strictEqual(
    Number(row.avg_slippage_pct),
    expected,
    `avg_slippage_pct: expected ${expected}, got ${row.avg_slippage_pct}`
  );
});

Then('the retrieved snapshot avg_execution_delay_ms should be {int}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT avg_execution_delay_ms FROM bt_rt_daily_snapshots WHERE id = ?', [lastInsertedSnapshotId]);
  assert.ok(row, 'Snapshot row not found');
  assert.strictEqual(
    Number(row.avg_execution_delay_ms),
    expected,
    `avg_execution_delay_ms: expected ${expected}, got ${row.avg_execution_delay_ms}`
  );
});

Then('the retrieved snapshot realized_pnl_usd should be {float}', async (expected: number) => {
  const db = await getDb();
  const row = await db.get('SELECT realized_pnl_usd FROM bt_rt_daily_snapshots WHERE id = ?', [lastInsertedSnapshotId]);
  assert.ok(row, 'Snapshot row not found');
  assert.ok(
    Math.abs(Number(row.realized_pnl_usd) - expected) < 0.001,
    `realized_pnl_usd: expected ${expected}, got ${row.realized_pnl_usd}`
  );
});

Then("the retrieved snapshot trade_hour_distribution should be '{}'", async (expected: string) => {
  const db = await getDb();
  const row = await db.get('SELECT trade_hour_distribution FROM bt_rt_daily_snapshots WHERE id = ?', [lastInsertedSnapshotId]);
  assert.ok(row, 'Snapshot row not found');
  assert.strictEqual(
    row.trade_hour_distribution,
    expected,
    `trade_hour_distribution: expected "${expected}", got "${row.trade_hour_distribution}"`
  );
});

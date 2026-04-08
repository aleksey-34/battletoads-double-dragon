const sqlite3 = require("sqlite3");
const { open } = require("sqlite");
async function main() {
  const db = await open({ filename: "/opt/battletoads-double-dragon/backend/database.db", driver: sqlite3.Database });
  
  // Check snapshot keys
  const row = await db.get("SELECT value FROM app_runtime_flags WHERE key = ?", "offer.store.ts_backtest_snapshots");
  if (row) {
    const obj = JSON.parse(row.value);
    const keys = Object.keys(obj);
    console.log("SNAPSHOT_COUNT:", keys.length);
    keys.forEach(k => console.log("SNAP_KEY:", k, "has_equity:", Array.isArray(obj[k].equityPoints) ? obj[k].equityPoints.length : 0));
  }

  // Check what TS names come from the trading systems
  const tsRows = await db.all("SELECT id, name FROM trading_systems WHERE name LIKE '%ALGOFUND_MASTER%' ORDER BY id");
  console.log("\nTS_COUNT:", tsRows.length);
  tsRows.forEach(r => console.log("TS:", r.name, "| id:", r.id));
}
main().catch(console.error);

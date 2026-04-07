#!/bin/bash
cd /opt/battletoads-double-dragon
node -e '
async function main() {
  const database = require("./backend/dist/utils/database");
  await database.initDB();
  const db = database.db;

  for (const keyName of ["BTDD_D1", "HDB_15"]) {
    const key = await db.get("SELECT id FROM api_keys WHERE name=?", [keyName]);
    if (!key) continue;

    // Get algofund profile
    const profile = await db.get("SELECT risk_multiplier, actual_enabled, published_system_name FROM algofund_profiles WHERE assigned_api_key_name=?", [keyName]);

    // Get balance
    const bal = await db.get("SELECT equity_usd FROM monitoring_snapshots WHERE api_key_id=? ORDER BY recorded_at DESC LIMIT 1", [key.id]);

    // Get runtime strategies with positions
    const strats = await db.all(
      "SELECT id, base_symbol, state, lot_long_percent, lot_short_percent, max_deposit, leverage, interval FROM strategies WHERE api_key_id=? AND is_runtime=1 AND state NOT IN (\"flat\",\"idle\") ORDER BY base_symbol",
      [key.id]
    );

    // Get all runtime strategies config
    const allStrats = await db.all(
      "SELECT id, base_symbol, lot_long_percent, lot_short_percent, max_deposit, leverage, interval FROM strategies WHERE api_key_id=? AND is_runtime=1 ORDER BY base_symbol LIMIT 20",
      [key.id]
    );

    console.log("=== " + keyName + " ===");
    console.log("  Profile: risk=" + (profile?.risk_multiplier||"?") + " enabled=" + (profile?.actual_enabled||"?") + " system=" + (profile?.published_system_name||"?"));
    console.log("  Balance: $" + (bal?.equity_usd||"?"));
    console.log("  Open positions:");
    for (const s of strats) {
      console.log("    #" + s.id + " " + s.base_symbol + " " + s.state + " lot_l=" + s.lot_long_percent + "% lot_s=" + s.lot_short_percent + "% maxDep=" + s.max_deposit + " lev=" + s.leverage + " tf=" + s.interval);
    }
    console.log("  All runtime strategies (config):");
    for (const s of allStrats) {
      console.log("    #" + s.id + " " + s.base_symbol + " lot_l=" + s.lot_long_percent + "% lot_s=" + s.lot_short_percent + "% maxDep=" + s.max_deposit + " lev=" + s.leverage);
    }
  }
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
'

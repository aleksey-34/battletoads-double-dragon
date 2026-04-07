#!/bin/bash
# DB cleanup script — fix ghosts, desync, stale strategies
cd /opt/battletoads-double-dragon

node -e '
async function main() {
  const database = require("./backend/dist/utils/database");
  await database.initDB();
  const db = database.db;

  // 1. HDB_18: Reset 2 ghost AUCTION positions to flat
  console.log("=== 1. FIX HDB_18 DESYNC ===");
  const hdb18ghosts = await db.all(
    "SELECT s.id, s.base_symbol, s.state FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id WHERE ak.name=\"HDB_18\" AND s.is_runtime=1 AND s.state NOT IN (\"flat\",\"idle\")"
  );
  console.log("  Found " + hdb18ghosts.length + " ghost positions:");
  for (const g of hdb18ghosts) {
    console.log("    #" + g.id + " " + g.base_symbol + " state=" + g.state);
    await db.run("UPDATE strategies SET state=\"flat\", entry_ratio=NULL, tp_anchor_ratio=NULL, last_action=\"admin_desync_reset\", updated_at=CURRENT_TIMESTAMP WHERE id=?", [g.id]);
    console.log("    -> reset to flat");
  }

  // 2. Mehmet_Bingx & mustafa: disable runtime + reset states (accounts gone)
  console.log("\n=== 2. CLEAN MEHMET_BINGX & MUSTAFA (gone) ===");
  for (const keyName of ["Mehmet_Bingx", "mustafa"]) {
    const result = await db.run(
      "UPDATE strategies SET state=\"flat\", entry_ratio=NULL, tp_anchor_ratio=NULL, is_runtime=0, is_active=0, last_action=\"admin_account_gone\", updated_at=CURRENT_TIMESTAMP WHERE api_key_id IN (SELECT id FROM api_keys WHERE name=?) AND state NOT IN (\"flat\",\"idle\")",
      [keyName]
    );
    console.log("  " + keyName + ": reset " + (result.changes || 0) + " strategies to flat+disabled");
    const result2 = await db.run(
      "UPDATE strategies SET is_runtime=0, is_active=0, updated_at=CURRENT_TIMESTAMP WHERE api_key_id IN (SELECT id FROM api_keys WHERE name=?) AND (is_runtime=1 OR is_active=1)",
      [keyName]
    );
    console.log("  " + keyName + ": disabled " + (result2.changes || 0) + " remaining runtime/active");
  }

  // 3. BTDD_D1: archive stale non-runtime strategies (10044 total, only 16 runtime)
  console.log("\n=== 3. CLEAN BTDD_D1 STALE STRATEGIES ===");
  const btddKey = await db.get("SELECT id FROM api_keys WHERE name=\"BTDD_D1\"");
  if (btddKey) {
    // First count
    const counts = await db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN is_runtime=1 THEN 1 ELSE 0 END) as runtime, SUM(CASE WHEN is_runtime=0 AND is_active=0 THEN 1 ELSE 0 END) as stale FROM strategies WHERE api_key_id=?",
      [btddKey.id]
    );
    console.log("  Before: total=" + counts.total + " runtime=" + counts.runtime + " stale=" + counts.stale);

    // Reset non-runtime to flat and mark archived
    const resetResult = await db.run(
      "UPDATE strategies SET state=\"flat\", entry_ratio=NULL, tp_anchor_ratio=NULL, is_active=0, is_archived=1, origin=\"saas_archived\", last_action=\"admin_bulk_archive\", updated_at=CURRENT_TIMESTAMP WHERE api_key_id=? AND is_runtime=0",
      [btddKey.id]
    );
    console.log("  Archived " + (resetResult.changes || 0) + " non-runtime strategies");

    // Verify
    const after = await db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN is_runtime=1 THEN 1 ELSE 0 END) as runtime, SUM(CASE WHEN is_archived=1 THEN 1 ELSE 0 END) as archived FROM strategies WHERE api_key_id=?",
      [btddKey.id]
    );
    console.log("  After: total=" + after.total + " runtime=" + after.runtime + " archived=" + after.archived);
  }

  // 4. Also disable HDB_18 (actual_enabled=0 in algofund_profiles)
  console.log("\n=== 4. VERIFY HDB_18 STATUS ===");
  const hdb18strats = await db.get(
    "SELECT COUNT(*) as total, SUM(CASE WHEN is_runtime=1 THEN 1 ELSE 0 END) as runtime, SUM(CASE WHEN state NOT IN (\"flat\",\"idle\") THEN 1 ELSE 0 END) as in_pos FROM strategies s JOIN api_keys ak ON s.api_key_id=ak.id WHERE ak.name=\"HDB_18\""
  );
  console.log("  HDB_18: total=" + hdb18strats.total + " runtime=" + hdb18strats.runtime + " in_pos=" + hdb18strats.in_pos);

  console.log("\n=== CLEANUP DONE ===");
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
'

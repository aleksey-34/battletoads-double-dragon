#!/bin/bash
cd /opt/battletoads-double-dragon

# Run daily sweep
node -e '
async function main() {
  const {initDB} = require("./backend/dist/utils/database");
  const {initResearchDb} = require("./backend/dist/research/db");
  await initDB();
  await initResearchDb();

  const {runSchedulerJobNow} = require("./backend/dist/research/schedulerService");
  const sweepResult = await runSchedulerJobNow("daily_incremental_sweep");
  console.log("SWEEP RESULT:", JSON.stringify(sweepResult, null, 2));

  const {refreshOfferStoreSnapshotsFromSweep} = require("./backend/dist/saas/service");
  const snapResult = await refreshOfferStoreSnapshotsFromSweep({ reason: "manual_cli", force: true });
  console.log("SNAPSHOT RESULT:", JSON.stringify({ok: snapResult.ok, skipped: snapResult.skipped, systemsUpdated: snapResult.systemsUpdated, offersUpdated: snapResult.offersUpdated, errors: snapResult.errors}, null, 2));
  process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
'

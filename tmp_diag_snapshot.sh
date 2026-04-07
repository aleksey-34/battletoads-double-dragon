#!/bin/bash
cd /opt/battletoads-double-dragon
node -e '
async function main() {
  const database = require("./backend/dist/utils/database");
  await database.initDB();
  const db = database.db;
  const row = await db.get("SELECT value FROM app_runtime_flags WHERE key = ?", ["offer.store.ts_backtest_snapshots"]);
  if (!row) { console.log("NO DATA"); process.exit(0); }
  const snap = JSON.parse(row.value);
  for (const [name, data] of Object.entries(snap)) {
    const d = data;
    const pts = d.equityPoints || [];
    const nonZero = pts.filter(v => v !== 0);
    console.log(name + ": pts=" + pts.length + " nonZero=" + nonZero.length + " first3=" + JSON.stringify(pts.slice(0,3)) + " last3=" + JSON.stringify(pts.slice(-3)) + " ret=" + d.ret + " trades=" + d.trades + " winRate=" + d.winRate);
  }
  
  // Also check what previewAdminSweepBacktest returns for main system
  const {initResearchDb} = require("./backend/dist/research/db");
  await initResearchDb();
  const {previewAdminSweepBacktest} = require("./backend/dist/saas/service");
  try {
    const preview = await previewAdminSweepBacktest({
      kind: "algofund-ts",
      systemName: "ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh",
      riskScore: 5,
      tradeFrequencyScore: 5,
      initialBalance: 10000,
      riskScaleMaxPercent: 40,
    });
    const eq = preview.preview?.equity || [];
    const nonZero = eq.filter(p => (p.equity || p.value || 0) !== 0);
    console.log("\nPREVIEW equity: total=" + eq.length + " nonZero=" + nonZero.length);
    if (eq.length > 0) {
      console.log("first:", JSON.stringify(eq[0]));
      console.log("last:", JSON.stringify(eq[eq.length-1]));
    }
    const summ = preview.preview?.summary || {};
    console.log("summary:", JSON.stringify({ret: summ.totalReturnPercent, dd: summ.maxDrawdownPercent, pf: summ.profitFactor, trades: summ.tradesCount, wr: summ.winRatePercent}));
  } catch(e) {
    console.log("PREVIEW ERROR:", e.message);
  }
  process.exit(0);
}
main().catch(e => { console.error("ERR:", e.message); process.exit(1); });
'

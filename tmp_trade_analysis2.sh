#!/bin/bash
cd /opt/battletoads-double-dragon

node -e '
async function main() {
  const database = require("./backend/dist/utils/database");
  const {initResearchDb} = require("./backend/dist/research/db");
  await database.initDB();
  await initResearchDb();
  const db = database.db;

  const now = new Date();
  const weekAgoMs = now.getTime() - 7*24*3600*1000;
  const dayAgoMs = now.getTime() - 24*3600*1000;

  // Active API keys
  const keys = await db.all("SELECT ak.id, ak.name FROM api_keys ak WHERE ak.id IN (SELECT DISTINCT s.api_key_id FROM strategies s WHERE s.is_runtime = 1)");
  console.log("=== ACTIVE API KEYS ===");
  for (const k of keys) console.log("  " + k.name + " (id=" + k.id + ")");

  // Trade events — WEEK
  console.log("\n=== TRADE EVENTS — LAST 7 DAYS ===");
  for (const k of keys) {
    const stats = await db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN trade_type = \"entry\" THEN 1 ELSE 0 END) as entries, SUM(CASE WHEN trade_type = \"exit\" THEN 1 ELSE 0 END) as exits FROM live_trade_events lte JOIN strategies s ON lte.strategy_id = s.id WHERE s.api_key_id = ? AND lte.actual_time >= ?",
      [k.id, weekAgoMs]
    );
    console.log("  " + k.name + ": " + stats.total + " events (" + stats.entries + " entries, " + stats.exits + " exits)");
  }

  // Trade events — DAY
  console.log("\n=== TRADE EVENTS — LAST 24H ===");
  for (const k of keys) {
    const stats = await db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN trade_type = \"entry\" THEN 1 ELSE 0 END) as entries, SUM(CASE WHEN trade_type = \"exit\" THEN 1 ELSE 0 END) as exits FROM live_trade_events lte JOIN strategies s ON lte.strategy_id = s.id WHERE s.api_key_id = ? AND lte.actual_time >= ?",
      [k.id, dayAgoMs]
    );
    console.log("  " + k.name + ": " + stats.total + " events (" + stats.entries + " entries, " + stats.exits + " exits)");
  }

  // PnL from exit trades — calculate from entry/actual prices
  console.log("\n=== PNL FROM EXITS — LAST 7 DAYS ===");
  for (const k of keys) {
    const exits = await db.all(
      "SELECT lte.side, lte.entry_price, lte.actual_price, lte.position_size, lte.actual_fee, s.base_symbol FROM live_trade_events lte JOIN strategies s ON lte.strategy_id = s.id WHERE s.api_key_id = ? AND lte.trade_type = \"exit\" AND lte.actual_time >= ? ORDER BY lte.actual_time DESC",
      [k.id, weekAgoMs]
    );
    let totalPnl = 0;
    let wins = 0, losses = 0;
    for (const e of exits) {
      const pnl = e.side === "long"
        ? (e.actual_price - e.entry_price) * e.position_size - (e.actual_fee || 0)
        : (e.entry_price - e.actual_price) * e.position_size - (e.actual_fee || 0);
      totalPnl += pnl;
      if (pnl >= 0) wins++; else losses++;
    }
    const wr = exits.length > 0 ? (wins / exits.length * 100).toFixed(1) : "N/A";
    console.log("  " + k.name + ": " + exits.length + " exits, PnL=$" + totalPnl.toFixed(2) + ", WR=" + wr + "% (W:" + wins + " L:" + losses + ")");
  }

  console.log("\n=== PNL FROM EXITS — LAST 24H ===");
  for (const k of keys) {
    const exits = await db.all(
      "SELECT lte.side, lte.entry_price, lte.actual_price, lte.position_size, lte.actual_fee, s.base_symbol FROM live_trade_events lte JOIN strategies s ON lte.strategy_id = s.id WHERE s.api_key_id = ? AND lte.trade_type = \"exit\" AND lte.actual_time >= ? ORDER BY lte.actual_time DESC",
      [k.id, dayAgoMs]
    );
    let totalPnl = 0;
    let wins = 0, losses = 0;
    for (const e of exits) {
      const pnl = e.side === "long"
        ? (e.actual_price - e.entry_price) * e.position_size - (e.actual_fee || 0)
        : (e.entry_price - e.actual_price) * e.position_size - (e.actual_fee || 0);
      totalPnl += pnl;
      if (pnl >= 0) wins++; else losses++;
    }
    const wr = exits.length > 0 ? (wins / exits.length * 100).toFixed(1) : "N/A";
    console.log("  " + k.name + ": " + exits.length + " exits, PnL=$" + totalPnl.toFixed(2) + ", WR=" + wr + "% (W:" + wins + " L:" + losses + ")");
  }

  // Open positions
  console.log("\n=== OPEN POSITIONS (state != flat/idle) ===");
  for (const k of keys) {
    const positions = await db.all(
      "SELECT base_symbol, state, max_deposit FROM strategies WHERE api_key_id = ? AND is_runtime = 1 AND state NOT IN (\"flat\",\"idle\") ORDER BY base_symbol",
      [k.id]
    );
    if (positions.length > 0) {
      console.log("  " + k.name + ": " + positions.length + " open");
      for (const p of positions) {
        console.log("    " + p.base_symbol + " " + p.state + " maxDep=" + p.max_deposit);
      }
    } else {
      console.log("  " + k.name + ": 0 open");
    }
  }

  // Balance snapshots
  console.log("\n=== BALANCE SNAPSHOTS ===");
  for (const k of keys) {
    const latest = await db.get("SELECT equity_usd, unrealized_pnl, drawdown_percent, recorded_at FROM monitoring_snapshots WHERE api_key_id = ? ORDER BY recorded_at DESC LIMIT 1", [k.id]);
    const weekSnap = await db.get("SELECT equity_usd, recorded_at FROM monitoring_snapshots WHERE api_key_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1", [k.id, new Date(weekAgoMs).toISOString()]);
    if (latest) {
      const change = weekSnap ? ((latest.equity_usd - weekSnap.equity_usd) / weekSnap.equity_usd * 100).toFixed(3) : "N/A";
      console.log("  " + k.name + ": $" + (latest.equity_usd||0).toFixed(2) + " (" + latest.recorded_at + ") DD=" + (latest.drawdown_percent||0).toFixed(2) + "% weekChange=" + change + "%");
    }
  }

  // Top 5 wins & losses
  console.log("\n=== TOP 5 PROFITABLE EXITS (WEEK) ===");
  const allExits = await db.all(
    "SELECT lte.side, lte.entry_price, lte.actual_price, lte.position_size, lte.actual_fee, s.base_symbol, ak.name as key_name, lte.actual_time FROM live_trade_events lte JOIN strategies s ON lte.strategy_id = s.id JOIN api_keys ak ON s.api_key_id = ak.id WHERE lte.trade_type = \"exit\" AND lte.actual_time >= ? ORDER BY lte.actual_time DESC",
    [weekAgoMs]
  );
  const withPnl = allExits.map(e => {
    const pnl = e.side === "long"
      ? (e.actual_price - e.entry_price) * e.position_size - (e.actual_fee || 0)
      : (e.entry_price - e.actual_price) * e.position_size - (e.actual_fee || 0);
    return {...e, pnl};
  });
  withPnl.sort((a,b) => b.pnl - a.pnl);
  for (const t of withPnl.slice(0,5)) {
    console.log("  " + t.key_name + " " + t.base_symbol + " " + t.side + ": $" + t.pnl.toFixed(2) + " (entry=" + t.entry_price + " exit=" + t.actual_price + ")");
  }
  console.log("\n=== TOP 5 LOSING EXITS (WEEK) ===");
  for (const t of withPnl.slice(-5).reverse()) {
    console.log("  " + t.key_name + " " + t.base_symbol + " " + t.side + ": $" + t.pnl.toFixed(2) + " (entry=" + t.entry_price + " exit=" + t.actual_price + ")");
  }

  // Backtest snapshot
  console.log("\n=== BACKTEST SNAPSHOT (from offer store) ===");
  const snapRow = await db.get("SELECT value FROM app_runtime_flags WHERE key = ?", ["offer.store.ts_backtest_snapshots"]);
  if (snapRow && snapRow.value) {
    const snap = JSON.parse(snapRow.value);
    for (const [sysName, data] of Object.entries(snap)) {
      const d = data;
      console.log("  System: " + sysName);
      console.log("    Return: " + d.ret + "% | DD: " + d.dd + "% | PF: " + d.pf + " | Trades: " + d.trades + " | WinRate: " + d.winRate + "%");
      if (d.equityPoints && d.equityPoints.length > 0) {
        const lastPts = d.equityPoints.slice(-7);
        console.log("    Last 7 equity pts: " + lastPts.map(p => (p.y||0).toFixed(1)).join(", "));
      }
    }
  }

  // Strategy counts
  console.log("\n=== STRATEGY COUNTS ===");
  for (const k of keys) {
    const c = await db.get(
      "SELECT COUNT(*) as total, SUM(CASE WHEN is_active=1 THEN 1 ELSE 0 END) as active, SUM(CASE WHEN is_runtime=1 THEN 1 ELSE 0 END) as runtime, SUM(CASE WHEN state NOT IN (\"flat\",\"idle\") THEN 1 ELSE 0 END) as in_pos FROM strategies WHERE api_key_id=?",
      [k.id]
    );
    console.log("  " + k.name + ": total=" + c.total + " active=" + c.active + " runtime=" + c.runtime + " in_pos=" + c.in_pos);
  }

  process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message); process.exit(1); });
'

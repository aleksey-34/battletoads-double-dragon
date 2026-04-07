#!/bin/bash
# Trade analysis vs backtest — week & day
cd /opt/battletoads-double-dragon

node -e '
async function main() {
  const database = require("./backend/dist/utils/database");
  const {initResearchDb} = require("./backend/dist/research/db");
  await database.initDB();
  await initResearchDb();
  const db = database.db;

  const now = new Date();
  const weekAgo = new Date(now.getTime() - 7*24*3600*1000).toISOString();
  const dayAgo = new Date(now.getTime() - 24*3600*1000).toISOString();

  // 1. Active API keys with trade activity
  const keys = await db.all(`SELECT ak.id, ak.name FROM api_keys ak WHERE ak.id IN (SELECT DISTINCT s.api_key_id FROM strategies s WHERE s.is_runtime = 1)`);
  console.log("=== ACTIVE API KEYS ===");
  for (const k of keys) console.log(`  ${k.name} (id=${k.id})`);

  // 2. Trade events summary per key — WEEK
  console.log("\n=== TRADE EVENTS — LAST 7 DAYS ===");
  for (const k of keys) {
    const stats = await db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN trade_type = "entry" THEN 1 ELSE 0 END) as entries,
        SUM(CASE WHEN trade_type = "exit" THEN 1 ELSE 0 END) as exits,
        SUM(CASE WHEN trade_type = "exit" THEN COALESCE(realized_pnl, 0) ELSE 0 END) as total_pnl
      FROM live_trade_events lte
      JOIN strategies s ON lte.strategy_id = s.id
      WHERE s.api_key_id = ? AND lte.created_at >= ?
    `, [k.id, weekAgo]);
    console.log(`  ${k.name}: ${stats.total} events (${stats.entries} entries, ${stats.exits} exits), PnL=$${(stats.total_pnl||0).toFixed(2)}`);
  }

  // 3. Trade events summary per key — DAY
  console.log("\n=== TRADE EVENTS — LAST 24H ===");
  for (const k of keys) {
    const stats = await db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN trade_type = "entry" THEN 1 ELSE 0 END) as entries,
        SUM(CASE WHEN trade_type = "exit" THEN 1 ELSE 0 END) as exits,
        SUM(CASE WHEN trade_type = "exit" THEN COALESCE(realized_pnl, 0) ELSE 0 END) as total_pnl
      FROM live_trade_events lte
      JOIN strategies s ON lte.strategy_id = s.id
      WHERE s.api_key_id = ? AND lte.created_at >= ?
    `, [k.id, dayAgo]);
    console.log(`  ${k.name}: ${stats.total} events (${stats.entries} entries, ${stats.exits} exits), PnL=$${(stats.total_pnl||0).toFixed(2)}`);
  }

  // 4. Open positions
  console.log("\n=== OPEN POSITIONS (state != idle) ===");
  for (const k of keys) {
    const positions = await db.all(`
      SELECT base_symbol, state, entry_price, position_size, max_deposit
      FROM strategies
      WHERE api_key_id = ? AND is_runtime = 1 AND state != "idle"
      ORDER BY base_symbol
    `, [k.id]);
    if (positions.length > 0) {
      console.log(`  ${k.name}: ${positions.length} open`);
      for (const p of positions) {
        console.log(`    ${p.base_symbol} ${p.state} entry=${p.entry_price} size=${p.position_size} maxDep=${p.max_deposit}`);
      }
    } else {
      console.log(`  ${k.name}: 0 open`);
    }
  }

  // 5. Balance timeline — latest monitoring snapshots
  console.log("\n=== BALANCE SNAPSHOTS ===");
  for (const k of keys) {
    const latest = await db.get(`
      SELECT equity_usd, unrealized_pnl, drawdown_percent, recorded_at
      FROM monitoring_snapshots
      WHERE api_key_id = ? ORDER BY recorded_at DESC LIMIT 1
    `, [k.id]);
    const weekAgoSnap = await db.get(`
      SELECT equity_usd, recorded_at
      FROM monitoring_snapshots
      WHERE api_key_id = ? AND recorded_at <= ? ORDER BY recorded_at DESC LIMIT 1
    `, [k.id, weekAgo]);
    if (latest) {
      const change = weekAgoSnap ? ((latest.equity_usd - weekAgoSnap.equity_usd) / weekAgoSnap.equity_usd * 100).toFixed(3) : "N/A";
      console.log(`  ${k.name}: $${latest.equity_usd?.toFixed(2)} (${latest.recorded_at}) | DD=${(latest.drawdown_percent||0).toFixed(2)}% | week change: ${change}%`);
    }
  }

  // 6. Top profitable & worst trades this week
  console.log("\n=== TOP 5 PROFITABLE EXITS (WEEK) ===");
  const topWins = await db.all(`
    SELECT s.base_symbol, ak.name as key_name, lte.realized_pnl, lte.entry_price, lte.actual_price, lte.created_at
    FROM live_trade_events lte
    JOIN strategies s ON lte.strategy_id = s.id
    JOIN api_keys ak ON s.api_key_id = ak.id
    WHERE lte.trade_type = "exit" AND lte.created_at >= ? AND lte.realized_pnl IS NOT NULL
    ORDER BY lte.realized_pnl DESC LIMIT 5
  `, [weekAgo]);
  for (const t of topWins) console.log(`  ${t.key_name} ${t.base_symbol}: $${t.realized_pnl?.toFixed(2)} (entry=${t.entry_price} exit=${t.actual_price})`);

  console.log("\n=== TOP 5 LOSING EXITS (WEEK) ===");
  const topLoss = await db.all(`
    SELECT s.base_symbol, ak.name as key_name, lte.realized_pnl, lte.entry_price, lte.actual_price, lte.created_at
    FROM live_trade_events lte
    JOIN strategies s ON lte.strategy_id = s.id
    JOIN api_keys ak ON s.api_key_id = ak.id
    WHERE lte.trade_type = "exit" AND lte.created_at >= ? AND lte.realized_pnl IS NOT NULL
    ORDER BY lte.realized_pnl ASC LIMIT 5
  `, [weekAgo]);
  for (const t of topLoss) console.log(`  ${t.key_name} ${t.base_symbol}: $${t.realized_pnl?.toFixed(2)} (entry=${t.entry_price} exit=${t.actual_price})`);

  // 7. Backtest snapshot data for comparison
  console.log("\n=== BACKTEST SNAPSHOT (from offer store) ===");
  const snapRow = await db.get("SELECT value FROM app_runtime_flags WHERE key = ?", ["offer.store.ts_backtest_snapshots"]);
  if (snapRow && snapRow.value) {
    const snap = JSON.parse(snapRow.value);
    if (typeof snap === "object") {
      for (const [sysName, data] of Object.entries(snap)) {
        const d = data;
        console.log(`  System: ${sysName}`);
        console.log(`    Return: ${d.ret}% | DD: ${d.dd}% | PF: ${d.pf} | Trades: ${d.trades} | WinRate: ${d.winRate}%`);
        if (d.equityPoints && d.equityPoints.length > 0) {
          const lastPts = d.equityPoints.slice(-7);
          console.log(`    Last 7 equity points: ${lastPts.map(p => p.y?.toFixed(1)).join(", ")}`);
        }
      }
    }
  } else {
    console.log("  No snapshot data found");
  }

  // 8. Strategy count summary
  console.log("\n=== STRATEGY COUNTS ===");
  for (const k of keys) {
    const counts = await db.get(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) as active,
        SUM(CASE WHEN is_runtime = 1 THEN 1 ELSE 0 END) as runtime,
        SUM(CASE WHEN state != "idle" THEN 1 ELSE 0 END) as in_position
      FROM strategies WHERE api_key_id = ?
    `, [k.id]);
    console.log(`  ${k.name}: total=${counts.total}, active=${counts.active}, runtime=${counts.runtime}, in_position=${counts.in_position}`);
  }

  process.exit(0);
}
main().catch(e => { console.error("ERROR:", e.message, e.stack); process.exit(1); });
'

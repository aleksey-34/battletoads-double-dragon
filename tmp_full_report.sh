#!/bin/bash
echo "========== SYSTEM STATUS =========="
date -u
uptime
echo ""

echo "========== SERVICES =========="
systemctl is-active btdd-api btdd-runtime btdd-research
echo ""

echo "========== RECENT API ERRORS (last 200 lines) =========="
journalctl -u btdd-api --no-pager -n 200 2>/dev/null | grep -iE 'error|ERR|fatal|crash|uncaught|ECONNREFUSED' | tail -20
echo ""

echo "========== RECENT RUNTIME ERRORS (last 200 lines) =========="
journalctl -u btdd-runtime --no-pager -n 200 2>/dev/null | grep -iE 'error|ERR|fatal|crash|uncaught' | tail -20
echo ""

echo "========== RECENT RESEARCH ERRORS (last 200 lines) =========="
journalctl -u btdd-research --no-pager -n 200 2>/dev/null | grep -iE 'error|ERR|fatal|crash|uncaught' | tail -20
echo ""

echo "========== RUNTIME LOG TAIL (last 30) =========="
journalctl -u btdd-runtime --no-pager -n 30 2>/dev/null | tail -30
echo ""

echo "========== STRATEGIES SUMMARY =========="
cd /opt/battletoads-double-dragon/backend
sqlite3 database.db "
SELECT ak.name AS api_key,
  COUNT(*) AS total,
  SUM(CASE WHEN s.is_active=1 THEN 1 ELSE 0 END) AS active,
  SUM(CASE WHEN s.is_runtime=1 THEN 1 ELSE 0 END) AS runtime,
  SUM(CASE WHEN s.is_archived=1 THEN 1 ELSE 0 END) AS archived,
  SUM(CASE WHEN s.entry_ratio IS NOT NULL AND s.entry_ratio != '' THEN 1 ELSE 0 END) AS in_pos
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE s.is_runtime=1 AND s.is_archived=0
GROUP BY ak.name;
"
echo ""

echo "========== OPEN POSITIONS DETAIL =========="
sqlite3 database.db "
SELECT ak.name, s.id, s.base_symbol, s.entry_ratio, s.max_deposit, s.lot_long_percent, s.leverage
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE s.is_runtime=1 AND s.is_archived=0 AND s.entry_ratio IS NOT NULL AND s.entry_ratio != '';
"
echo ""

echo "========== LATEST BALANCES =========="
sqlite3 database.db "
SELECT ak.name, ms.equity_usd, ms.recorded_at
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ms.id IN (
  SELECT MAX(id) FROM monitoring_snapshots GROUP BY api_key_id
);
"
echo ""

echo "========== LATEST TRADE EVENTS (last 10) =========="
sqlite3 database.db "
SELECT lte.id, ak.name, s.base_symbol, lte.trade_type, lte.side, lte.entry_price, lte.actual_price, lte.position_size, lte.actual_time
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
ORDER BY lte.id DESC LIMIT 10;
"
echo ""

echo "========== BACKTEST SNAPSHOTS =========="
sqlite3 database.db "
SELECT ts.name, ts.is_active,
  json_extract(ts.backtest_snapshot_json, '$.totalReturnPercent') AS ret,
  json_extract(ts.backtest_snapshot_json, '$.maxDrawdownPercent') AS dd,
  json_extract(ts.backtest_snapshot_json, '$.profitFactor') AS pf,
  json_extract(ts.backtest_snapshot_json, '$.tradesCount') AS trades,
  json_extract(ts.backtest_snapshot_json, '$.winRate') AS wr,
  json_extract(ts.backtest_snapshot_json, '$.equityPoints') AS eq_sample
FROM trading_systems ts
WHERE ts.backtest_snapshot_json IS NOT NULL AND ts.backtest_snapshot_json != '{}' AND ts.backtest_snapshot_json != '';
" 2>&1 | head -30
echo ""

echo "========== SCHEDULER STATUS =========="
sqlite3 /opt/battletoads-double-dragon/research.db "
SELECT job_key, is_enabled, last_status, last_run_at, next_run_at, run_count FROM research_scheduler_jobs;
"
echo ""

echo "========== ALGOFUND PROFILES =========="
sqlite3 database.db "
SELECT t.slug, ap.risk_multiplier, ap.actual_enabled, ap.published_system_name, ap.execution_api_key_name
FROM algofund_profiles ap
JOIN tenants t ON t.id = ap.tenant_id;
"
echo ""

echo "========== SUBSCRIPTIONS =========="
sqlite3 database.db "
SELECT t.slug, p.code, p.max_deposit_total, s.status
FROM subscriptions s
JOIN tenants t ON t.id = s.tenant_id
JOIN plans p ON p.id = s.plan_id
ORDER BY s.id;
"
echo ""

echo "========== MAX_DEPOSIT SYNC CHECK =========="
sqlite3 database.db "
SELECT ak.name, s.max_deposit, COUNT(*) AS cnt
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE s.is_runtime=1 AND s.is_archived=0
GROUP BY ak.name, s.max_deposit;
"

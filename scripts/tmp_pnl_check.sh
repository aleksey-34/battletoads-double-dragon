#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== ACTIVE STRATEGIES ==="
sqlite3 "$DB" "SELECT api_key_name, COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active FROM trading_strategies WHERE api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY api_key_name;"

echo ""
echo "=== RECENT TRADE EVENTS (last 7 days) ==="
sqlite3 "$DB" "SELECT api_key_name, COUNT(*) as events, MIN(created_at) as first_event, MAX(created_at) as last_event FROM strategy_events WHERE created_at > datetime('now','-7 days') AND api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY api_key_name;"

echo ""
echo "=== PNL SUMMARY (last 7 days) ==="
sqlite3 "$DB" "SELECT api_key_name, SUM(CASE WHEN event_type='close' THEN COALESCE(realized_pnl,0) ELSE 0 END) as realized_pnl, COUNT(CASE WHEN event_type='close' THEN 1 END) as closed_trades, COUNT(CASE WHEN event_type='open' THEN 1 END) as opened_trades FROM strategy_events WHERE created_at > datetime('now','-7 days') AND api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY api_key_name;"

echo ""
echo "=== OPEN POSITIONS NOW ==="
sqlite3 "$DB" "SELECT api_key_name, symbol, side, qty, entry_price, created_at FROM strategy_positions WHERE api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') ORDER BY api_key_name, symbol;" 2>/dev/null || echo "(no positions table or empty)"

echo ""
echo "=== BACKTEST SNAPSHOT (from runtime flags) ==="
sqlite3 "$DB" "SELECT key, json_extract(value,'$.ret') as ret_pct, json_extract(value,'$.dd') as dd_pct, json_extract(value,'$.pf') as pf, json_extract(value,'$.trades') as trades, json_extract(value,'$.periodDays') as period_days FROM app_runtime_flags WHERE key LIKE 'algofund_backtest_snapshot:%' LIMIT 20;"

echo ""
echo "=== BALANCE HISTORY (monitoring snapshots, last 14 days) ==="
sqlite3 "$DB" "SELECT api_key_name, date(created_at) as dt, equity_usd, balance_usd FROM monitoring_snapshots WHERE created_at > datetime('now','-14 days') AND api_key_name IN ('BTDD_D1','HDB_15') ORDER BY api_key_name, created_at;" 2>/dev/null || echo "(no monitoring_snapshots table)"

echo ""
echo "=== RUNTIME LOG: last cycle stats ==="
tail -100 /opt/battletoads-double-dragon/backend/logs/combined.log | grep -i 'cycle\|failed\|error\|pnl\|balance' | tail -20

echo ""
echo "=== RUNTIME LOG: recent order executions ==="
grep -i 'Placed.*order\|Closed.*position\|close.*ccxt\|SELL\|BUY' /opt/battletoads-double-dragon/backend/logs/combined.log | tail -40

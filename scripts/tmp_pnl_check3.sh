#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== API KEYS ==="
sqlite3 -header -column "$DB" "SELECT id, name, exchange FROM api_keys;"

echo ""
echo "=== STRATEGIES PER API KEY ==="
sqlite3 -header -column "$DB" "SELECT ak.name as api_key, COUNT(s.id) as total, SUM(s.is_active) as active, SUM(CASE WHEN s.is_runtime=1 THEN 1 ELSE 0 END) as runtime, SUM(CASE WHEN s.state='long' THEN 1 WHEN s.state='short' THEN 1 ELSE 0 END) as in_position FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id WHERE ak.name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY ak.name;"

echo ""
echo "=== POSITIONS (strategies in long/short state) ==="
sqlite3 -header -column "$DB" "SELECT ak.name as api_key, s.id, s.base_symbol||'/'||s.quote_symbol as pair, s.interval, s.state, s.max_deposit, s.lot_long_percent as lot_pct, s.leverage, s.updated_at FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id WHERE s.state IN ('long','short') AND ak.name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') ORDER BY ak.name;"

echo ""
echo "=== LIVE TRADE EVENTS (last 7 days) ==="
sqlite3 -header -column "$DB" "SELECT ak.name as api_key, COUNT(e.id) as events, SUM(CASE WHEN e.trade_type='entry' THEN 1 ELSE 0 END) as entries, SUM(CASE WHEN e.trade_type='exit' THEN 1 ELSE 0 END) as exits FROM live_trade_events e JOIN strategies s ON s.id=e.strategy_id JOIN api_keys ak ON ak.id=s.api_key_id WHERE e.created_at > (strftime('%s','now','-7 days')*1000) AND ak.name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY ak.name;"

echo ""
echo "=== MONITORING BALANCE HISTORY (last 14 days) ==="
sqlite3 -header -column "$DB" "SELECT ak.name as api_key, date(ms.recorded_at) as dt, ROUND(AVG(ms.equity_usd),2) as avg_equity, ROUND(MIN(ms.equity_usd),2) as min_eq, ROUND(MAX(ms.equity_usd),2) as max_eq, ROUND(AVG(ms.drawdown_percent),2) as avg_dd FROM monitoring_snapshots ms JOIN api_keys ak ON ak.id=ms.api_key_id WHERE ms.recorded_at > datetime('now','-14 days') AND ak.name IN ('BTDD_D1','HDB_15') GROUP BY ak.name, date(ms.recorded_at) ORDER BY ak.name, dt;"

echo ""
echo "=== BACKTEST SNAPSHOTS ==="
sqlite3 -header -column "$DB" "SELECT key, json_extract(value,'$.ret') as ret, json_extract(value,'$.dd') as dd, json_extract(value,'$.pf') as pf, json_extract(value,'$.trades') as trades, json_extract(value,'$.periodDays') as days FROM app_runtime_flags WHERE key LIKE '%backtest%snapshot%';"

echo ""
echo "=== ALGOFUND ACTIVE SYSTEMS ==="
sqlite3 -header -column "$DB" "SELECT * FROM algofund_active_systems LIMIT 20;"

echo ""
echo "=== RUNTIME ERROR RATE TODAY ==="
today=$(date -u +%Y-%m-%d)
total=$(grep "$today" /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -c 'Auto strategy cycle')
failed=$(grep "$today" /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep 'Auto strategy cycle' | grep -oP 'failed=\K\d+' | tail -1)
echo "Cycles today: $total, last failed count: $failed"

echo ""
echo "=== LAST ALGOFUND ORDERS (non-synctrade, non-razgon) ==="
grep -iE 'Placed.*order|Closed.*position' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -v Synctrade | grep -v Razgon | grep -v HDB_14 | tail -20

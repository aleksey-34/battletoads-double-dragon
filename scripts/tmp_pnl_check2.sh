#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== TRADING SYSTEMS (algofund) ==="
sqlite3 -header -column "$DB" "SELECT ts.id, ts.name, ts.api_key_name, ts.status, COUNT(m.id) as members FROM trading_systems ts LEFT JOIN trading_system_members m ON m.trading_system_id=ts.id WHERE ts.api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY ts.id ORDER BY ts.api_key_name, ts.id;"

echo ""
echo "=== STRATEGIES (per api key) ==="
sqlite3 -header -column "$DB" "SELECT api_key_name, COUNT(*) as total, SUM(CASE WHEN status='active' THEN 1 ELSE 0 END) as active, SUM(CASE WHEN status='stopped' THEN 1 ELSE 0 END) as stopped FROM strategies WHERE api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY api_key_name;"

echo ""
echo "=== LIVE TRADE EVENTS (last 7 days) ==="
sqlite3 -header -column "$DB" "SELECT api_key_name, COUNT(*) as events, SUM(CASE WHEN side='buy' OR side='Buy' THEN 1 ELSE 0 END) as buys, SUM(CASE WHEN side='sell' OR side='Sell' THEN 1 ELSE 0 END) as sells, MIN(created_at) as first_ev, MAX(created_at) as last_ev FROM live_trade_events WHERE created_at > datetime('now','-7 days') AND api_key_name IN ('BTDD_D1','HDB_15','HDB_18','Mehmet_Bingx','mustafa') GROUP BY api_key_name;"

echo ""
echo "=== MONITORING SNAPSHOTS (balance timeline, last 14 days) ==="
sqlite3 -header -column "$DB" "SELECT api_key_name, date(created_at) as dt, ROUND(AVG(equity_usd),2) as avg_equity, ROUND(MIN(equity_usd),2) as min_eq, ROUND(MAX(equity_usd),2) as max_eq FROM monitoring_snapshots WHERE created_at > datetime('now','-14 days') AND api_key_name IN ('BTDD_D1','HDB_15','HDB_18') GROUP BY api_key_name, date(created_at) ORDER BY api_key_name, dt;"

echo ""
echo "=== BACKTEST SNAPSHOTS ==="
sqlite3 -header -column "$DB" "SELECT key, json_extract(value,'$.ret') as ret_pct, json_extract(value,'$.dd') as dd_pct, json_extract(value,'$.pf') as pf, json_extract(value,'$.trades') as trades, json_extract(value,'$.periodDays') as period_days FROM app_runtime_flags WHERE key LIKE 'algofund_backtest_snapshot:%';"

echo ""
echo "=== ALGOFUND PROFILES ==="
sqlite3 -header -column "$DB" "SELECT ap.tenant_id, t.display_name, t.slug, ap.risk_multiplier, ap.actual_enabled, ap.published_system_name, ap.assigned_api_key_name FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id;"

echo ""
echo "=== RUNTIME CYCLE ERRORS (today) ==="
grep -i 'failed\|error' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep "$(date -u +%Y-%m-%d)" | grep -v 'Razgon:HDB_14' | tail -15

echo ""
echo "=== LAST 3 DAYS ORDER ACTIVITY (algofund keys only) ==="
grep -iE 'Placed.*order|Closed.*position' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -v Synctrade | grep -v Razgon | tail -30

#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== ALGOFUND PROFILE ==="
sqlite3 $DB "SELECT tenant_id, actual_enabled, requested_enabled, assigned_api_key_name FROM algofund_profiles WHERE assigned_api_key_name = 'Mehmet_Bingx';"

echo "=== MONITORING PEAK vs CURRENT ==="
sqlite3 $DB "SELECT MAX(equity_usd) as peak, MIN(equity_usd) as min_eq, MAX(drawdown_percent) as max_dd, MAX(recorded_at) as last_snap FROM monitoring_snapshots WHERE api_key_id = 8;"

echo "=== LAST TRADE EVENTS ==="
sqlite3 $DB "SELECT lte.side, lte.trade_type, lte.source_symbol, datetime(lte.entry_time/1000, 'unixepoch') as entry FROM live_trade_events lte WHERE lte.strategy_id IN (18254,18255,18256,18257,18258,18259) ORDER BY lte.id DESC LIMIT 10;"

echo "=== ENGINE LOG (Mehmet) last 30 lines ==="
grep -i "Mehmet_Bingx\|mehmet-bingx" /opt/battletoads-double-dragon/backend/logs/combined.log | tail -30

echo "=== ERRORS (109400) since restart ==="
grep "109400" /opt/battletoads-double-dragon/backend/logs/error.log | tail -5

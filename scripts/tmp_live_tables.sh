set -e
for db in /opt/battletoads-double-dragon/database.db /opt/battletoads-double-dragon/backend/database.db /opt/battletoads-double-dragon/backend/main.db /opt/battletoads-double-dragon/data/main.db; do
  echo "=== $db ==="
  sqlite3 -header -column "$db" "select name from sqlite_master where type='table' and name in ('tenants','algofund_profiles','strategy_runtime_events','live_trade_events','trading_systems','api_keys','positions');"
done
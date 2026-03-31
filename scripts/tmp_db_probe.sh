set -e
for db in /opt/battletoads-double-dragon/database.db /opt/battletoads-double-dragon/backend/database.db /opt/battletoads-double-dragon/backend/research.db /opt/battletoads-double-dragon/research.db; do
  echo "=== $db ==="
  sqlite3 -header -column "$db" "select count(*) as tenants_cnt from tenants;" 2>/dev/null || echo 'no tenants table'
  sqlite3 -header -column "$db" "select count(*) as systems_cnt from trading_systems;" 2>/dev/null || echo 'no trading_systems table'
  sqlite3 -header -column "$db" "select name from sqlite_master where type='table' and name like '%algofund%';" 2>/dev/null || true
  sqlite3 -header -column "$db" "select name from sqlite_master where type='table' and name like '%strategy%runtime%';" 2>/dev/null || true
  sqlite3 -header -column "$db" "select name from sqlite_master where type='table' and name like '%live_trade%';" 2>/dev/null || true
  echo
 done
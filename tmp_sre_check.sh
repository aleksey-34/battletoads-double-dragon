#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== strategy_runtime_events schema ==="
sqlite3 database.db ".schema strategy_runtime_events"

echo ""
echo "=== Recent runtime events for strategy 80165 ==="
sqlite3 database.db "SELECT * FROM strategy_runtime_events WHERE strategy_id=80165 ORDER BY id DESC LIMIT 15;" 2>&1 | head -30

echo ""
echo "=== Check columns ==="
sqlite3 database.db "PRAGMA table_info(strategy_runtime_events);"

echo ""
echo "=== Recent events with readable columns ==="
sqlite3 database.db "
SELECT id, strategy_id, 
  substr(result_json, 1, 200) AS result_preview,
  created_at 
FROM strategy_runtime_events 
WHERE strategy_id=80165 
ORDER BY id DESC LIMIT 10;
" 2>&1 | head -30

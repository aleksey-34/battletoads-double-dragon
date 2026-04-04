#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. Total strategies count ==="
sqlite3 database.db "SELECT COUNT(*) FROM strategies;"

echo ""
echo "=== 2. Max strategy ID ==="
sqlite3 database.db "SELECT MAX(id) FROM strategies;"

echo ""
echo "=== 3. Last 10 strategies ==="
sqlite3 database.db "SELECT id, name, api_key_id, max_deposit, leverage, base_symbol, quote_symbol, strategy_type FROM strategies ORDER BY id DESC LIMIT 10;"

echo ""
echo "=== 4. Is there a runtime_strategies or dynamic strategies table? ==="
sqlite3 database.db ".tables" | tr ' ' '\n' | grep -i strat

echo ""
echo "=== 5. All tables ==="
sqlite3 database.db ".tables"

echo ""
echo "=== 6. Check if strategy 80158 exists anywhere ==="
sqlite3 database.db "SELECT name FROM sqlite_master WHERE type='table';" | while read tbl; do
  cnt=$(sqlite3 database.db "SELECT COUNT(*) FROM $tbl WHERE EXISTS (SELECT 1 FROM $tbl WHERE typeof(id)='integer' AND id=80158);" 2>/dev/null)
  if [ "$cnt" != "0" ] && [ ! -z "$cnt" ]; then
    echo "$tbl: has rows (checked for id=80158)"
    sqlite3 database.db "SELECT * FROM $tbl WHERE id=80158 LIMIT 1;" 2>/dev/null
  fi
done

echo ""
echo "=== 7. runtime strategies or strategy_instances? ==="
sqlite3 database.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%strat%';"
sqlite3 database.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%instance%';"
sqlite3 database.db "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%runtime%';"

echo ""
echo "=== 8. live_trade_events - what strategy_ids exist? ==="
sqlite3 database.db "SELECT DISTINCT strategy_id FROM live_trade_events ORDER BY strategy_id LIMIT 30;"

echo ""
echo "=== 9. Check if those strategy IDs are in strategies table ==="
sqlite3 database.db "
SELECT lte.strategy_id, s.id as s_id, s.name, s.max_deposit
FROM (SELECT DISTINCT strategy_id FROM live_trade_events) lte
LEFT JOIN strategies s ON s.id = lte.strategy_id
LIMIT 20;
"

echo ""
echo "=== DONE ==="

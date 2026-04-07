#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== Strategy 80165 runtime events with entry_ratio changes ==="
sqlite3 database.db "
SELECT sre.id, sre.action, sre.current_ratio, sre.entry_ratio_before, sre.entry_ratio_after, datetime(sre.created_at) AS t
FROM strategy_runtime_events sre
WHERE sre.strategy_id = 80165
ORDER BY sre.id DESC LIMIT 20;
" 2>&1

echo ""
echo "=== Check if strategy_runtime_events table exists ==="
sqlite3 database.db ".schema strategy_runtime_events" 2>&1 | head -5

echo ""
echo "=== Check audit log for strategy 80165 ==="
sqlite3 database.db "
SELECT id, action, details, created_at FROM saas_audit_log
WHERE details LIKE '%80165%'
ORDER BY id DESC LIMIT 5;
" 2>&1

echo ""
echo "=== Actually just check: is entry_ratio ALWAYS equal to latest currentRatio? ==="
echo "For ALL entries and their matching exits:"
sqlite3 database.db "
WITH entry_exit AS (
  SELECT lte.id, lte.strategy_id, lte.trade_type, lte.entry_price, lte.actual_price,
    datetime(lte.actual_time/1000,'unixepoch') AS t,
    LAG(lte.entry_price) OVER (PARTITION BY lte.strategy_id ORDER BY lte.id) AS prev_entry_price,
    LAG(lte.trade_type) OVER (PARTITION BY lte.strategy_id ORDER BY lte.id) AS prev_type
  FROM live_trade_events lte
  WHERE lte.strategy_id = 80165
)
SELECT id, trade_type, entry_price, actual_price, prev_entry_price, prev_type, t
FROM entry_exit
ORDER BY id DESC LIMIT 20;
"

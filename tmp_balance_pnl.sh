#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== PNL DEBUG LOGS ==="
journalctl -u btdd-runtime --no-pager -n 500 2>/dev/null | grep 'pnl_debug' | tail -20

echo ""
echo "=== BALANCE HISTORY BTDD_D1 (last 20 snapshots) ==="
sqlite3 database.db "
SELECT equity_usd, datetime(recorded_at) AS t
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='BTDD_D1')
ORDER BY id DESC LIMIT 20;
"

echo ""
echo "=== BALANCE HISTORY HDB_15 (last 20) ==="
sqlite3 database.db "
SELECT equity_usd, datetime(recorded_at) AS t
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='HDB_15')
ORDER BY id DESC LIMIT 20;
"

echo ""
echo "=== BALANCE HISTORY HDB_18 (last 20) ==="
sqlite3 database.db "
SELECT equity_usd, datetime(recorded_at) AS t
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='HDB_18')
ORDER BY id DESC LIMIT 20;
"

echo ""
echo "=== NEW EXITS SINCE DEBUG DEPLOY? ==="
sqlite3 database.db "
SELECT lte.id, ak.name, s.base_symbol, lte.side, lte.entry_price, lte.actual_price,
  datetime(lte.actual_time/1000,'unixepoch') AS t
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE lte.trade_type='exit' AND lte.actual_time > 1775520000000
ORDER BY lte.id DESC LIMIT 10;
"

echo ""
echo "=== ACTUAL PNL from matching entry/exit pairs (last 15 exits) ==="
sqlite3 database.db "
WITH exits AS (
  SELECT lte.id AS exit_id, lte.strategy_id, lte.side, lte.actual_price AS exit_price,
    lte.actual_time AS exit_time, lte.position_size
  FROM live_trade_events lte
  WHERE lte.trade_type='exit'
  ORDER BY lte.id DESC LIMIT 15
),
entries AS (
  SELECT lte.strategy_id, lte.actual_price AS entry_price, lte.actual_time AS entry_time,
    lte.id AS entry_id
  FROM live_trade_events lte
  WHERE lte.trade_type='entry'
)
SELECT e.exit_id, ak.name, s.base_symbol, e.side,
  en.entry_price, e.exit_price,
  CASE
    WHEN e.side='long' THEN printf('%.4f%%', (e.exit_price - en.entry_price) / en.entry_price * 100)
    WHEN e.side='short' THEN printf('%.4f%%', (en.entry_price - e.exit_price) / en.entry_price * 100)
  END AS pnl_pct,
  datetime(e.exit_time/1000,'unixepoch') AS exit_t
FROM exits e
JOIN entries en ON en.strategy_id = e.strategy_id AND en.entry_time < e.exit_time
  AND en.entry_id = (
    SELECT MAX(lte2.id) FROM live_trade_events lte2
    WHERE lte2.strategy_id = e.strategy_id AND lte2.trade_type='entry' AND lte2.id < e.exit_id
  )
JOIN strategies s ON s.id = e.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
ORDER BY e.exit_id DESC;
"

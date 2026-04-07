#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== EXITS with timestamps ==="
sqlite3 database.db "
SELECT lte.id, ak.name, s.base_symbol, lte.side,
  lte.entry_price, lte.actual_price,
  CASE WHEN ABS(lte.entry_price - lte.actual_price) < 0.0000001 THEN 'SAME' ELSE 'DIFF' END AS price_cmp,
  datetime(lte.actual_time/1000, 'unixepoch') AS exit_time
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE lte.trade_type = 'exit'
ORDER BY lte.id DESC LIMIT 30;
"

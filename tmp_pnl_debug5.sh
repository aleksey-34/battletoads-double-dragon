#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== Full event sequence for strategy 80165 BERAUSDT ==="
sqlite3 database.db "
SELECT lte.id, lte.trade_type, lte.side, 
  printf('%.6f', lte.entry_price) AS entry_p,
  printf('%.6f', lte.actual_price) AS actual_p,
  CASE 
    WHEN lte.trade_type='exit' THEN printf('%.6f', lte.entry_price - lte.actual_price)
    ELSE '-'
  END AS diff,
  datetime(lte.actual_time/1000,'unixepoch') AS t
FROM live_trade_events lte
WHERE lte.strategy_id = 80165
ORDER BY lte.id DESC LIMIT 30;
"

echo ""
echo "=== Check if maybe the actual deployed code has an issue ==="
echo "=== Show exact lines around exitEntryRatio in compiled JS ==="
cd /opt/battletoads-double-dragon/backend
sed -n '1590,1620p' dist/bot/strategy.js

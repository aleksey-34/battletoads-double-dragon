#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== Check compiled persistFlatAfterExit ==="
grep -n 'exitEntryRatio' dist/bot/strategy.js 2>/dev/null | head -10
echo ""
echo "=== Check compiled recordRuntimeTradeEvent entryPriceOverride ==="
grep -n 'entryPriceOverride\|resolvedEntryPrice' dist/bot/strategy.js 2>/dev/null | head -10
echo ""
echo "=== Check if dist exists ==="
ls -la dist/bot/strategy.js 2>/dev/null | head -3
echo ""
echo "=== npm run build output ==="
ls -la dist/bot/ 2>/dev/null | head -10
echo ""
echo "=== strategy_id for exit 1286 ==="
sqlite3 database.db "SELECT strategy_id FROM live_trade_events WHERE id=1286;"
echo ""
echo "=== entry_ratio for that strategy at entry time ==="
sqlite3 database.db "
SELECT lte.id, lte.trade_type, lte.entry_price, lte.actual_price, 
  datetime(lte.actual_time/1000,'unixepoch') AS t
FROM live_trade_events lte
WHERE lte.strategy_id = (SELECT strategy_id FROM live_trade_events WHERE id=1286)
ORDER BY lte.id DESC LIMIT 5;
"

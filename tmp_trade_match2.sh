#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. trading_systems table schema ==="
sqlite3 database.db ".schema trading_systems" 2>/dev/null

echo ""
echo "=== 2. ALL trading_systems (any key) ==="
sqlite3 database.db "SELECT id, name, api_key_id, status, substr(config,1,200) FROM trading_systems LIMIT 10;" 2>/dev/null

echo ""
echo "=== 3. ALL api_keys ==="
sqlite3 database.db "SELECT id, name, exchange FROM api_keys;" 2>/dev/null

echo ""
echo "=== 4. auto_strategies table? ==="
sqlite3 database.db ".schema auto_strategies" 2>/dev/null

echo ""
echo "=== 5. active strategies count by api_key ==="
sqlite3 database.db "
SELECT ak.name, COUNT(*) as cnt
FROM auto_strategies s
JOIN api_keys ak ON s.api_key_id = ak.id
WHERE s.enabled = 1
GROUP BY ak.name;
" 2>/dev/null

echo ""
echo "=== 6. sample auto_strategy for BTDD_D1 ==="
sqlite3 database.db "
SELECT s.id, s.type, s.symbol, s.interval, s.enabled, s.api_key_id,
  json_extract(s.params, '$.lotSizePercent') as lot_pct,
  json_extract(s.params, '$.lotSizeUsdt') as lot_usdt,
  json_extract(s.params, '$.initialBalance') as init_bal,
  substr(s.params, 1, 300) as params_preview
FROM auto_strategies s
JOIN api_keys ak ON s.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1'
LIMIT 3;
" 2>/dev/null

echo ""
echo "=== 7. BTDD_D1 placed orders in last 7d logs ==="
grep -a 'Placed.*order\|Placed.*ccxt\|Executed.*strategy.*BTDD' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -i 'BTDD_D1' | tail -20

echo ""
echo "=== 8. ANY placed orders in last lines ==="
grep -a 'Placed order\|Placed.*ccxt order' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | tail -20

echo ""
echo "=== 9. live_trade_events full schema + count ==="
sqlite3 database.db ".schema live_trade_events" 2>/dev/null
echo "---"
sqlite3 database.db "SELECT COUNT(*) FROM live_trade_events;" 2>/dev/null

echo ""
echo "=== DONE ==="

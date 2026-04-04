#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. strategies table schema ==="
sqlite3 database.db ".schema strategies" 2>/dev/null

echo ""
echo "=== 2. strategies for BTDD_D1 (ids 80158,80159,80166,80168) ==="
sqlite3 database.db "
SELECT id, api_key_id, type, symbol, interval, enabled,
  json_extract(params, '$.lotSizePercent') as lot_pct,
  json_extract(params, '$.lotSizeUsdt') as lot_usdt,
  json_extract(params, '$.depositUsdt') as deposit,
  substr(params, 1, 400) as params_preview
FROM strategies
WHERE id IN (80158, 80159, 80166, 80168);
" 2>/dev/null

echo ""
echo "=== 3. live_trade_events last 20 (any) ==="
sqlite3 database.db "
SELECT lte.id, lte.strategy_id, lte.trade_type, lte.side, 
  lte.source_symbol, lte.position_size, lte.actual_price, 
  datetime(lte.actual_time/1000, 'unixepoch') as ts,
  lte.slippage_percent
FROM live_trade_events lte
ORDER BY lte.actual_time DESC
LIMIT 20;
" 2>/dev/null

echo ""
echo "=== 4. live_trade_events for BTDD_D1 strategies ==="
sqlite3 database.db "
SELECT lte.id, lte.strategy_id, lte.trade_type, lte.side,
  lte.source_symbol, lte.position_size, lte.actual_price,
  datetime(lte.actual_time/1000, 'unixepoch') as ts
FROM live_trade_events lte
WHERE lte.strategy_id IN (80158, 80159, 80166, 80168)
ORDER BY lte.actual_time DESC
LIMIT 20;
" 2>/dev/null

echo ""
echo "=== 5. strategies count by api_key ==="
sqlite3 database.db "
SELECT ak.name, COUNT(*) as cnt, SUM(s.enabled) as active
FROM strategies s
JOIN api_keys ak ON s.api_key_id = ak.id
GROUP BY ak.name;
" 2>/dev/null

echo ""
echo "=== 6. BTDD_D1 strategy types and symbols ==="
sqlite3 database.db "
SELECT s.type, s.symbol, s.interval, s.enabled, s.id
FROM strategies s
JOIN api_keys ak ON s.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1' AND s.enabled = 1
ORDER BY s.type, s.symbol;
" 2>/dev/null

echo ""
echo "=== 7. algofund_profiles lot/risk config ==="
sqlite3 database.db "
SELECT ap.id, ap.tenant_id, ap.risk_level, ap.api_key_name,
  ap.published_system_name, ap.enabled,
  json_extract(ap.config, '$.lotSizePercent') as lot_pct,
  json_extract(ap.config, '$.depositUsdt') as deposit,
  substr(ap.config, 1, 300) as config_preview
FROM algofund_profiles ap;
" 2>/dev/null

echo ""
echo "=== DONE ==="

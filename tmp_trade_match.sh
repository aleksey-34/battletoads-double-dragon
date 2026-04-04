#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. BTDD_D1 TRADING SYSTEMS CONFIG (lot sizing, deposit settings) ==="
sqlite3 database.db "
SELECT ts.id, ts.name, ts.config
FROM trading_systems ts
JOIN api_keys ak ON ts.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1'
LIMIT 5;
" 2>/dev/null

echo ""
echo "=== 2. RECENT BTDD_D1 TRADE SIGNALS (last 48h from logs) ==="
grep -a 'BTDD_D1\|Placed order\|Closed position\|strategy.*for BTDD' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -v 'Synctrade\|synctrade\|alisanyilmaz\|leventyilmaz' | tail -60

echo ""
echo "=== 3. LIVE_TRADE_EVENTS for BTDD_D1 (last 20) ==="
sqlite3 database.db "
SELECT lte.id, lte.api_key_id, lte.symbol, lte.side, lte.qty, lte.price, lte.pnl, lte.created_at
FROM live_trade_events lte
JOIN api_keys ak ON lte.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1'
ORDER BY lte.created_at DESC
LIMIT 20;
" 2>/dev/null

echo ""
echo "=== 4. STRATEGY EXECUTION COUNT BY SYMBOL (BTDD_D1, last 7 days) ==="
sqlite3 database.db "
SELECT lte.symbol, COUNT(*) as trades, SUM(lte.pnl) as total_pnl
FROM live_trade_events lte
JOIN api_keys ak ON lte.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1'
  AND lte.created_at > datetime('now', '-7 days')
GROUP BY lte.symbol
ORDER BY trades DESC;
" 2>/dev/null

echo ""
echo "=== 5. BACKTEST SNAPSHOT SYMBOLS (from app_runtime_flags) ==="
sqlite3 database.db "
SELECT key, length(value) as val_len,
  substr(value, 1, 500) as preview
FROM app_runtime_flags
WHERE key LIKE '%backtest%'
LIMIT 3;
" 2>/dev/null

echo ""
echo "=== 6. TS CONFIG DETAIL - first ALGOFUND_MASTER system ==="
sqlite3 database.db "
SELECT ts.id, ts.name, ts.status,
  json_extract(ts.config, '$.riskMultiplier') as risk_mult,
  json_extract(ts.config, '$.lotSizePercent') as lot_pct,
  json_extract(ts.config, '$.initialBalance') as init_bal,
  json_extract(ts.config, '$.maxPositions') as max_pos,
  json_extract(ts.config, '$.strategies') as strats_preview
FROM trading_systems ts
WHERE ts.name LIKE '%ALGOFUND%' OR ts.name LIKE '%algofund%'
LIMIT 5;
" 2>/dev/null

echo ""
echo "=== 7. HOW MANY STRATEGIES PER TS, AND WHAT TYPES ==="
sqlite3 database.db "
SELECT ts.name,
  json_array_length(json_extract(ts.config, '$.strategies')) as num_strats,
  substr(json_extract(ts.config, '$.strategies'), 1, 300) as strats_start
FROM trading_systems ts
JOIN api_keys ak ON ts.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1' AND ts.status = 'active'
LIMIT 5;
" 2>/dev/null

echo ""
echo "=== 8. ACTUAL LOT SIZE IN STRATEGY CONFIG ==="
sqlite3 database.db "
SELECT ts.name,
  json_extract(ts.config, '$.strategies[0].params.lotSizePercent') as lot0,
  json_extract(ts.config, '$.strategies[0].params.lotSizeUsdt') as lotUsdt0,
  json_extract(ts.config, '$.strategies[0].type') as type0,
  json_extract(ts.config, '$.strategies[0].params') as params0
FROM trading_systems ts
JOIN api_keys ak ON ts.api_key_id = ak.id
WHERE ak.name = 'BTDD_D1' AND ts.status = 'active'
LIMIT 3;
" 2>/dev/null

echo ""
echo "=== DONE ==="

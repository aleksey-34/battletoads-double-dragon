#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "========== BACKTEST SNAPSHOTS (offer_store) =========="
sqlite3 database.db "
SELECT key, 
  json_extract(value, '$.systemName') AS sys,
  json_extract(value, '$.totalReturnPercent') AS ret,
  json_extract(value, '$.maxDrawdownPercent') AS dd,
  json_extract(value, '$.profitFactor') AS pf,
  json_extract(value, '$.tradesCount') AS trades,
  json_extract(value, '$.winRate') AS wr
FROM app_runtime_flags
WHERE key LIKE '%snapshot%' OR key LIKE '%backtest%';
" 2>&1 | head -30

echo ""
echo "========== TRADING SYSTEMS =========="
sqlite3 database.db "
SELECT id, name, api_key_id, is_active, 
  (SELECT COUNT(*) FROM trading_system_members tsm WHERE tsm.trading_system_id = ts.id) AS members
FROM trading_systems ts;
"

echo ""
echo "========== PNL CHECK (entry vs exit prices, last 20 exits) =========="
sqlite3 database.db "
SELECT lte.id, ak.name, s.base_symbol, lte.side, 
  lte.entry_price, lte.actual_price,
  CASE WHEN lte.entry_price = lte.actual_price THEN 'SAME' ELSE 'OK' END AS price_check,
  lte.actual_time
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE lte.trade_type = 'exit'
ORDER BY lte.id DESC LIMIT 20;
"

echo ""
echo "========== TRADE COUNTS BY DAY (last 7 days) =========="
sqlite3 database.db "
SELECT date(actual_time/1000, 'unixepoch') AS day,
  SUM(CASE WHEN trade_type='entry' THEN 1 ELSE 0 END) AS entries,
  SUM(CASE WHEN trade_type='exit' THEN 1 ELSE 0 END) AS exits,
  COUNT(*) AS total
FROM live_trade_events
WHERE actual_time > (strftime('%s','now','-7 days') * 1000)
GROUP BY day ORDER BY day;
"

echo ""
echo "========== RUNTIME FLAGS (sweep/snapshot related) =========="
sqlite3 database.db "
SELECT key, LENGTH(value) AS val_len, 
  SUBSTR(value, 1, 120) AS val_preview
FROM app_runtime_flags
WHERE key LIKE '%sweep%' OR key LIKE '%snapshot%' OR key LIKE '%maxDeposit%'
ORDER BY key;
"

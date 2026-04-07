#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "========== 1. STRATEGY TYPES IN RUNTIME =========="
sqlite3 database.db "
SELECT ak.name, s.id, s.base_symbol, s.strategy_type, s.market_mode, s.interval, s.state, s.is_active,
  s.long_enabled, s.short_enabled, s.detection_source
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name='BTDD_D1' AND s.is_runtime=1 AND s.is_archived=0
ORDER BY s.strategy_type, s.base_symbol;
"

echo ""
echo "========== 2. TRADE EVENTS BY STRATEGY TYPE =========="
sqlite3 database.db "
SELECT s.strategy_type, s.market_mode, s.base_symbol,
  COUNT(*) AS total_events,
  SUM(CASE WHEN lte.trade_type='entry' THEN 1 ELSE 0 END) AS entries,
  SUM(CASE WHEN lte.trade_type='exit' THEN 1 ELSE 0 END) AS exits
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name='BTDD_D1'
GROUP BY s.strategy_type, s.market_mode, s.base_symbol
ORDER BY total_events DESC;
"

echo ""
echo "========== 3. PNL BY STRATEGY TYPE (from entry/exit pairs) =========="
sqlite3 database.db "
WITH exits AS (
  SELECT lte.id AS exit_id, lte.strategy_id, lte.side, lte.actual_price AS exit_price, lte.actual_time
  FROM live_trade_events lte
  JOIN strategies s ON s.id = lte.strategy_id
  JOIN api_keys ak ON ak.id = s.api_key_id
  WHERE lte.trade_type='exit' AND ak.name='BTDD_D1'
),
pairs AS (
  SELECT e.exit_id, e.strategy_id, e.side, e.exit_price, e.actual_time,
    en.actual_price AS entry_price,
    CASE
      WHEN e.side='long' THEN (e.exit_price - en.actual_price) / en.actual_price * 100
      WHEN e.side='short' THEN (en.actual_price - e.exit_price) / en.actual_price * 100
    END AS pnl_pct
  FROM exits e
  JOIN live_trade_events en ON en.strategy_id = e.strategy_id AND en.trade_type='entry'
    AND en.id = (SELECT MAX(lte2.id) FROM live_trade_events lte2 WHERE lte2.strategy_id=e.strategy_id AND lte2.trade_type='entry' AND lte2.id < e.exit_id)
)
SELECT s.strategy_type, s.market_mode, s.base_symbol,
  COUNT(*) AS trades,
  SUM(CASE WHEN p.pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN p.pnl_pct <= 0 THEN 1 ELSE 0 END) AS losses,
  printf('%.4f', AVG(p.pnl_pct)) AS avg_pnl_pct,
  printf('%.4f', SUM(p.pnl_pct)) AS total_pnl_pct,
  printf('%.4f', MIN(p.pnl_pct)) AS worst,
  printf('%.4f', MAX(p.pnl_pct)) AS best
FROM pairs p
JOIN strategies s ON s.id = p.strategy_id
GROUP BY s.strategy_type, s.market_mode, s.base_symbol
ORDER BY total_pnl_pct ASC;
"

echo ""
echo "========== 4. TRADING SYSTEM MEMBERS =========="
sqlite3 database.db "
SELECT ts.id, ts.name, ts.is_active, tsm.strategy_id, tsm.weight,
  s.base_symbol, s.strategy_type, s.market_mode, s.state
FROM trading_systems ts
JOIN trading_system_members tsm ON tsm.system_id = ts.id
JOIN strategies s ON s.id = tsm.strategy_id
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name='BTDD_D1'
ORDER BY ts.name, tsm.weight DESC;
"

echo ""
echo "========== 5. BACKTEST SNAPSHOT DATA =========="
sqlite3 database.db "
SELECT key, 
  json_extract(value, '$.totalReturnPercent') AS ret,
  json_extract(value, '$.maxDrawdownPercent') AS dd,
  json_extract(value, '$.profitFactor') AS pf,
  json_extract(value, '$.tradesCount') AS trades,
  json_extract(value, '$.winRate') AS wr
FROM app_runtime_flags
WHERE key = 'offer.store.ts_backtest_snapshots';
" 2>&1 | head -5

echo ""
echo "========== 6. FULL BACKTEST SNAPSHOTS JSON (first 2000 chars) =========="
sqlite3 database.db "
SELECT substr(value, 1, 3000)
FROM app_runtime_flags
WHERE key = 'offer.store.ts_backtest_snapshots';
"

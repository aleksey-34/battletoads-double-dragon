#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== BTDD_D1 BALANCE OVER TIME (daily min) ==="
sqlite3 database.db "
SELECT date(recorded_at) AS day, 
  MIN(equity_usd) AS min_bal,
  MAX(equity_usd) AS max_bal,
  printf('%.2f', MAX(equity_usd) - MIN(equity_usd)) AS range
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='BTDD_D1')
GROUP BY day
ORDER BY day DESC LIMIT 14;
"

echo ""
echo "=== HDB_18 BALANCE OVER TIME ==="
sqlite3 database.db "
SELECT date(recorded_at) AS day, 
  MIN(equity_usd) AS min_bal,
  MAX(equity_usd) AS max_bal
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='HDB_18')
GROUP BY day
ORDER BY day DESC LIMIT 14;
"

echo ""
echo "=== PNL SUMMARY: wins vs losses (last 50 exits) ==="
sqlite3 database.db "
WITH exits AS (
  SELECT lte.id AS exit_id, lte.strategy_id, lte.side, lte.actual_price AS exit_price, lte.actual_time
  FROM live_trade_events lte WHERE lte.trade_type='exit'
  ORDER BY lte.id DESC LIMIT 50
),
pairs AS (
  SELECT e.exit_id, e.side,
    en.actual_price AS entry_price, e.exit_price,
    CASE
      WHEN e.side='long' THEN (e.exit_price - en.actual_price) / en.actual_price * 100
      WHEN e.side='short' THEN (en.actual_price - e.exit_price) / en.actual_price * 100
    END AS pnl_pct
  FROM exits e
  JOIN live_trade_events en ON en.strategy_id = e.strategy_id AND en.trade_type='entry'
    AND en.id = (SELECT MAX(lte2.id) FROM live_trade_events lte2 WHERE lte2.strategy_id=e.strategy_id AND lte2.trade_type='entry' AND lte2.id < e.exit_id)
)
SELECT 
  COUNT(*) AS total,
  SUM(CASE WHEN pnl_pct > 0 THEN 1 ELSE 0 END) AS wins,
  SUM(CASE WHEN pnl_pct <= 0 THEN 1 ELSE 0 END) AS losses,
  printf('%.4f%%', AVG(pnl_pct)) AS avg_pnl,
  printf('%.4f%%', MIN(pnl_pct)) AS worst,
  printf('%.4f%%', MAX(pnl_pct)) AS best
FROM pairs;
"

echo ""
echo "=== FEES IMPACT: check if comissions drain balance ==="
echo "With 10% lot on 5000 cap = 500 notional per trade"
echo "Typical fee: 0.04% maker = 0.20 USDT per trade"
echo "At ~30 trades/day = ~6 USDT/day in fees"

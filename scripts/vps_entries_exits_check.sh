#!/usr/bin/env bash
set -euo pipefail
cd /opt/battletoads-double-dragon/backend
sqlite3 -header -column database.db <<'SQL'
WITH target AS (
  SELECT id,name
  FROM trading_systems
  WHERE name IN (
    'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v',
    'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
  )
),
m AS (
  SELECT t.name AS system_name, tsm.strategy_id
  FROM target t
  JOIN trading_system_members tsm ON tsm.system_id=t.id
),
e AS (
  SELECT m.system_name, lower(lte.trade_type) AS trade_type, COUNT(*) AS cnt
  FROM m
  JOIN live_trade_events lte ON lte.strategy_id=m.strategy_id
  WHERE lte.actual_time >= (strftime('%s','now')-30*24*3600)*1000
  GROUP BY m.system_name, lower(lte.trade_type)
)
SELECT
  system_name,
  COALESCE(SUM(CASE WHEN trade_type='entry' THEN cnt END),0) AS entries_30d,
  COALESCE(SUM(CASE WHEN trade_type='exit' THEN cnt END),0) AS exits_30d
FROM e
GROUP BY system_name;
SQL

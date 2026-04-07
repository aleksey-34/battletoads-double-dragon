#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. HDB_15 MONITORING (last 14 days) ==="
sqlite3 database.db "
SELECT date(recorded_at) as day, 
  MIN(equity) as min_eq, MAX(equity) as max_eq,
  COUNT(*) as snapshots,
  MAX(margin_load_percent) as max_ml
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='HDB_15')
  AND equity > 0
  AND recorded_at > datetime('now', '-14 days')
GROUP BY day
ORDER BY day;
"

echo ""
echo "=== 2. BTDD_D1 MONITORING (last 30 days) ==="
sqlite3 database.db "
SELECT date(recorded_at) as day,
  MIN(equity) as min_eq, MAX(equity) as max_eq,
  COUNT(*) as snapshots,
  MAX(margin_load_percent) as max_ml
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name='BTDD_D1')
  AND equity > 0
  AND recorded_at > datetime('now', '-30 days')
GROUP BY day
ORDER BY day;
"

echo ""
echo "=== 3. HDB_15 STRATEGIES (active) ==="
sqlite3 database.db "
SELECT s.id, s.name, s.strategy_type, s.base_symbol, s.quote_symbol, 
  s.interval, s.state, s.max_deposit, s.lot_long_percent, s.leverage,
  s.last_action, s.updated_at
FROM strategies s
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name='HDB_15')
  AND s.is_active = 1
ORDER BY s.updated_at DESC;
"

echo ""
echo "=== 4. BTDD_D1 STRATEGIES (active) ==="
sqlite3 database.db "
SELECT s.id, s.name, s.strategy_type, s.base_symbol, s.quote_symbol,
  s.interval, s.state, s.max_deposit, s.lot_long_percent, s.leverage,
  s.last_action, s.updated_at
FROM strategies s
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name='BTDD_D1')
  AND s.is_active = 1
ORDER BY s.updated_at DESC
LIMIT 15;
"

echo ""
echo "=== 5. BACKTEST SNAPSHOTS ==="
sqlite3 database.db "
SELECT key, substr(value, 1, 800)
FROM app_runtime_flags
WHERE key = 'offer.store.ts_backtest_snapshots';
"

echo ""
echo "=== 6. LIVE TRADE EVENTS last 7 days (by api_key) ==="
sqlite3 database.db "
SELECT ak.name, lte.side, lte.source_symbol, COUNT(*) as cnt,
  SUM(CASE WHEN lte.trade_type='exit' THEN 1 ELSE 0 END) as exits,
  MIN(datetime(lte.actual_time/1000, 'unixepoch')) as first_trade,
  MAX(datetime(lte.actual_time/1000, 'unixepoch')) as last_trade
FROM live_trade_events lte
JOIN strategies s ON lte.strategy_id = s.id
JOIN api_keys ak ON s.api_key_id = ak.id
WHERE lte.actual_time > (strftime('%s','now','-7 days') * 1000)
GROUP BY ak.name, lte.side, lte.source_symbol
ORDER BY ak.name, cnt DESC;
"

echo ""
echo "=== 7. HDB_15 PnL from live_trade_events ==="
sqlite3 database.db "
SELECT lte.source_symbol, lte.trade_type, lte.side,
  lte.position_size, lte.actual_price,
  datetime(lte.actual_time/1000, 'unixepoch') as ts
FROM live_trade_events lte
JOIN strategies s ON lte.strategy_id = s.id
JOIN api_keys ak ON s.api_key_id = ak.id
WHERE ak.name = 'HDB_15'
  AND lte.actual_time > (strftime('%s','now','-7 days') * 1000)
ORDER BY lte.actual_time DESC
LIMIT 30;
"

echo ""
echo "=== 8. RECENT PLACED ORDERS (last 24h from logs) ==="
grep -a 'Placed.*order\|Placed.*ccxt\|Executed.*strategy' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -i 'HDB_15\|BTDD_D1' | tail -30

echo ""
echo "=== 9. BACKTEST vs REAL comparison ==="
echo "Backtest snapshots available systems:"
sqlite3 database.db "
SELECT json_each.key, 
  json_extract(json_each.value, '$.ret') as ret_pct,
  json_extract(json_each.value, '$.dd') as dd_pct,
  json_extract(json_each.value, '$.trades') as trades,
  json_extract(json_each.value, '$.periodDays') as period_days,
  json_extract(json_each.value, '$.tradesPerDay') as trades_day,
  json_extract(json_each.value, '$.finalEquity') as final_eq
FROM app_runtime_flags, json_each(value)
WHERE key = 'offer.store.ts_backtest_snapshots';
"

echo ""
echo "=== 10. ALGOFUND PROFILES (connected clients) ==="
sqlite3 database.db "
SELECT ap.tenant_id, t.slug, ap.published_system_name, ap.risk_multiplier,
  ap.assigned_api_key_name, ap.actual_enabled, ap.requested_enabled
FROM algofund_profiles ap
JOIN tenants t ON ap.tenant_id = t.id
WHERE ap.published_system_name != '' OR ap.assigned_api_key_name != '';
"

echo ""
echo "=== DONE ==="

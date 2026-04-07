#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "========== DD_BattleToads: 18 entries, 0 exits on BERAUSDT mono ==="
echo "Strategy 80159 - what last_action history looks like:"
sqlite3 database.db "SELECT id, base_symbol, strategy_type, state, entry_ratio, last_action, last_signal FROM strategies WHERE id=80159;"

echo ""
echo "=== All entries for strategy 80159 ==="
sqlite3 database.db "
SELECT lte.id, lte.trade_type, lte.side, lte.actual_price, lte.position_size, datetime(lte.actual_time/1000,'unixepoch') AS t
FROM live_trade_events lte WHERE lte.strategy_id=80159 ORDER BY lte.id;
"

echo ""
echo "=== DD_BattleToads 80156 IPUSDT synth - 24 entries, 0 exits ==="
sqlite3 database.db "
SELECT lte.id, lte.trade_type, lte.side, lte.actual_price, datetime(lte.actual_time/1000,'unixepoch') AS t
FROM live_trade_events lte WHERE lte.strategy_id=80156 ORDER BY lte.id DESC LIMIT 10;
"

echo ""
echo "========== SUMMARY: entries vs exits per strategy =========="
sqlite3 database.db "
SELECT s.id, s.base_symbol, s.strategy_type, s.market_mode,
  SUM(CASE WHEN lte.trade_type='entry' THEN 1 ELSE 0 END) AS entries,
  SUM(CASE WHEN lte.trade_type='exit' THEN 1 ELSE 0 END) AS exits,
  COUNT(*) AS total
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
JOIN live_trade_events lte ON lte.strategy_id = s.id
WHERE ak.name='BTDD_D1' AND s.is_runtime=1
GROUP BY s.id
ORDER BY s.strategy_type, entries DESC;
"

echo ""
echo "========== DD_BattleToads strategy params ==="
sqlite3 database.db "
SELECT id, base_symbol, strategy_type, market_mode, 
  take_profit_percent, price_channel_length, detection_source,
  zscore_entry, zscore_exit, zscore_stop,
  long_enabled, short_enabled
FROM strategies
WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') 
  AND is_runtime=1
ORDER BY strategy_type;
"

echo ""
echo "========== What's happening: DD_BattleToads entries look like desync entries ==="
echo "Are they 'opened_long' or 'state_resynced_long'?"
sqlite3 database.db "
SELECT lte.id, s.id AS sid, s.strategy_type, lte.side,
  CASE 
    WHEN lte.actual_time = lte.entry_time THEN 'bar_time=actual' 
    ELSE 'bar_time!=actual'
  END AS timing,
  datetime(lte.actual_time/1000,'unixepoch') AS t,
  datetime(lte.entry_time/1000,'unixepoch') AS bar_t
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
WHERE s.strategy_type='DD_BattleToads' AND s.api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1')
ORDER BY lte.id DESC LIMIT 20;
"

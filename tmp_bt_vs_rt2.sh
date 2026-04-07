#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== Schema: trading_system_members ==="
sqlite3 database.db "PRAGMA table_info(trading_system_members);"

echo ""
echo "=== Schema: backtest_runs ==="
sqlite3 database.db "PRAGMA table_info(backtest_runs);"

echo ""
echo "=== Schema: backtest_predictions ==="
sqlite3 database.db "PRAGMA table_info(backtest_predictions);"

echo ""
echo "=== DD strategies in ALGOFUND TS ==="
sqlite3 database.db "
SELECT m.*, s.base_symbol, s.strategy_type, s.state, s.entry_ratio, s.tp_anchor_ratio,
       s.take_profit_percent, s.price_channel_length
FROM trading_system_members m
JOIN strategies s ON s.id=m.strategy_id
WHERE s.strategy_type='DD_BattleToads' AND m.trading_system_id IN (
  SELECT id FROM trading_systems WHERE name LIKE '%btdd%' OR name LIKE '%ALGOFUND%'
)
ORDER BY s.id;
"

echo ""
echo "=== Backtest runs for ALGOFUND strategies ==="
sqlite3 database.db "SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 5;"

echo ""
echo "=== offer.store snapshot keys ==="
sqlite3 database.db "SELECT key FROM app_runtime_flags WHERE key LIKE 'offer%' ORDER BY key;" 

echo ""
echo "=== All DD_BattleToads entries are ONLY 'entry' - no 'exit' trade_type at all? ==="
sqlite3 database.db "
SELECT trade_type, COUNT(*) FROM live_trade_events 
WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads')
GROUP BY trade_type;
"

echo ""
echo "=== Compare: zz_breakout and stat_arb DO have exits ==="
sqlite3 database.db "
SELECT s.strategy_type, lte.trade_type, COUNT(*) 
FROM live_trade_events lte
JOIN strategies s ON lte.strategy_id=s.id
WHERE s.strategy_type IN ('zz_breakout','stat_arb_zscore','DD_BattleToads')
GROUP BY s.strategy_type, lte.trade_type
ORDER BY s.strategy_type, lte.trade_type;
"

echo ""
echo "=== Strategy 80166: AUCTION long, entry=4.659, anchor=4.731 ==="
sqlite3 database.db "SELECT id, base_symbol, state, entry_ratio, tp_anchor_ratio, take_profit_percent, last_action, last_signal FROM strategies WHERE id=80166;"

echo ""
echo "=== Strategy 80159: BERA mono, currently flat ==="  
sqlite3 database.db "SELECT id, base_symbol, state, entry_ratio, tp_anchor_ratio, take_profit_percent, last_action, last_signal FROM strategies WHERE id=80159;"

echo ""
echo "=== How does backtest engine get its candle data? ==="
echo "=== Check engine.ts for DD_BattleToads signal computation ==="
grep -n 'computeDonchian\|donchianCenter\|signal.*long\|signal.*short' /opt/battletoads-double-dragon/backend/dist/backtest/engine.js | head -30

echo ""
echo "=== Check runtime evaluateAndExecute for how donchianCenter is computed ==="
grep -n 'donchianCenter' /opt/battletoads-double-dragon/backend/dist/bot/strategy.js | head -20

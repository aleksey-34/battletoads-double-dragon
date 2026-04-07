#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== DD strategies ==="
sqlite3 database.db "SELECT id, base_symbol, quote_symbol, strategy_type, market_mode, state, entry_ratio, tp_anchor_ratio, last_action FROM strategies WHERE strategy_type='DD_BattleToads' ORDER BY id;"

echo ""
echo "=== DD live_trade_events ==="
sqlite3 database.db "SELECT id, strategy_id, trade_type, side, entry_price, actual_price, created_at FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads') ORDER BY id DESC LIMIT 30;"

echo ""
echo "=== DD trade_type counts ==="
sqlite3 database.db "SELECT trade_type, COUNT(*) FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads') GROUP BY trade_type;"

echo ""
echo "=== strategy_runtime_events columns ==="
sqlite3 database.db "PRAGMA table_info(strategy_runtime_events);"

echo ""
echo "=== strategy_runtime_events for DD ==="
sqlite3 database.db "SELECT * FROM strategy_runtime_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads') ORDER BY rowid DESC LIMIT 20;"

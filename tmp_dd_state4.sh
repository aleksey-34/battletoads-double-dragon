#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== strategies columns ==="
sqlite3 database.db "PRAGMA table_info(strategies);" | head -40

echo ""
echo "=== live_trade_events columns ==="
sqlite3 database.db "PRAGMA table_info(live_trade_events);"

echo ""
echo "=== DD strategies ==="
sqlite3 database.db "SELECT id, symbol, strategy_type, market_mode, state, entry_ratio, tp_anchor_ratio, last_action FROM strategies WHERE strategy_type='DD_BattleToads' LIMIT 10;"

echo ""
echo "=== DD live_trade_events ==="
sqlite3 database.db "SELECT id, strategy_id, event_type, side, entry_price, actual_price, memo, created_at FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads') ORDER BY id DESC LIMIT 30;"

echo ""
echo "=== DD exit count ==="
sqlite3 database.db "SELECT event_type, COUNT(*) FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads') GROUP BY event_type;"

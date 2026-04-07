#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== DD_BattleToads strategies state ==="
sqlite3 database.db "SELECT id, pair_symbol, strategy_type, market_mode, state, entry_ratio, tp_anchor_ratio, last_action FROM strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND' ORDER BY id;"

echo ""
echo "=== DD exit events ==="
sqlite3 database.db "SELECT strategy_id, action, side, memo FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND') AND action='exit' LIMIT 20;"

echo ""
echo "=== DD event action counts ==="
sqlite3 database.db "SELECT action, COUNT(*) FROM live_trade_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND') GROUP BY action;"

echo ""
echo "=== DD strategy columns ==="
sqlite3 database.db "PRAGMA table_info(strategies);" | grep -E 'pair_symbol|state|entry_ratio|tp_anchor|last_action|take_profit|channel'

echo ""
echo "=== strategy_runtime_events for DD ==="
sqlite3 database.db "SELECT strategy_id, event_type, created_at FROM strategy_runtime_events WHERE strategy_id IN (SELECT id FROM strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND') ORDER BY created_at DESC LIMIT 20;"

echo ""
echo "=== Recent runtime log for DD strategies ==="
journalctl -u btdd-runtime --since '4 hours ago' --no-pager 2>/dev/null | grep -E '80156|80159|80161|80163|80166|80170' | tail -30

#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== Tables ==="
sqlite3 database.db ".tables"

echo ""
echo "=== DD_BattleToads state ==="
sqlite3 database.db "SELECT id, pair_symbol, strategy_type, market_mode, state, entry_ratio, tp_anchor_ratio, last_action FROM runtime_strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND' ORDER BY id;"

echo ""
echo "=== Runtime logs for DD exits ==="
sqlite3 database.db "SELECT strategy_id, action, side, memo FROM runtime_trade_events WHERE strategy_id IN (SELECT id FROM runtime_strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND') AND action='exit' LIMIT 20;"

echo ""  
echo "=== All DD event actions ==="
sqlite3 database.db "SELECT action, COUNT(*) FROM runtime_trade_events WHERE strategy_id IN (SELECT id FROM runtime_strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND') GROUP BY action;"

echo ""
echo "=== DD last_action values ==="
sqlite3 database.db "SELECT id, pair_symbol, state, last_action FROM runtime_strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND';"

echo ""
echo "=== Recent runtime logs mentioning DD ==="
journalctl -u btdd-runtime --since '2 hours ago' --no-pager 2>/dev/null | grep -i 'DD_BattleToads\|80156\|80159\|80161\|80163\|80166\|80170' | tail -20

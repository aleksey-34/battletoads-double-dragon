#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== DD_BattleToads current state ==="
sqlite3 database.db "SELECT id, symbol, strategy_type, market_mode, state, entry_ratio, last_action FROM strategies WHERE strategy_type='DD_BattleToads' AND tenant='ALGOFUND' ORDER BY id;"

echo ""
echo "=== DD_BattleToads open positions ==="
sqlite3 database.db "SELECT s.id, s.symbol, s.strategy_type, s.state, p.side, p.entry_price, p.notional, p.opened_at FROM strategies s LEFT JOIN positions p ON s.id=p.strategy_id WHERE s.strategy_type='DD_BattleToads' AND s.tenant='ALGOFUND';"

echo ""
echo "=== DD_BattleToads: how many bar_time!=actual vs real entries ==="
sqlite3 database.db "SELECT s.strategy_type, te.memo, COUNT(*) FROM trade_events te JOIN strategies s ON te.strategy_id=s.id WHERE s.strategy_type='DD_BattleToads' AND s.tenant='ALGOFUND' GROUP BY s.strategy_type, te.memo;"

echo ""
echo "=== DD product code: grep evaluateAndExecute for DD ==="
grep -n 'DD_BattleToads\|donchian\|Donchian' /opt/battletoads-double-dragon/backend/dist/bot/strategy.js | head -30

echo ""
echo "=== Check if DD has exit logic at all ==="
grep -n -A3 'take_profit_percent\|flatAfterExit\|exitSignal.*DD\|DD.*exit' /opt/battletoads-double-dragon/backend/dist/bot/strategy.js | head -40

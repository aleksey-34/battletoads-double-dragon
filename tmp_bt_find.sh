#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== BTDD_D1 TS members ==="
sqlite3 database.db "
SELECT m.id, m.system_id, m.strategy_id, m.weight, s.base_symbol, s.quote_symbol, s.strategy_type, s.market_mode, s.state
FROM trading_system_members m
JOIN strategies s ON s.id = m.strategy_id
JOIN trading_systems ts ON ts.id = m.system_id
WHERE ts.name LIKE '%btdd%' OR ts.name LIKE '%BTDD%'
ORDER BY s.strategy_type, s.base_symbol;
"

echo ""
echo "=== Backtest runs table ==="
sqlite3 database.db "SELECT * FROM backtest_runs ORDER BY id DESC LIMIT 3;"

echo ""
echo "=== Keys with tradeLog data ==="
sqlite3 database.db "SELECT key, LENGTH(value) FROM app_runtime_flags WHERE value LIKE '%DD_BattleToads%' AND value LIKE '%tradeLog%' ORDER BY key;"

echo ""
echo "=== Keys with DD_BattleToads in value ==="
sqlite3 database.db "SELECT key, LENGTH(value) FROM app_runtime_flags WHERE value LIKE '%DD_BattleToads%' ORDER BY key;"

echo ""
echo "=== review_snapshots: check one DD offer structure ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.review_snapshots';" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
data = json.loads(raw)
for k in data:
    if 'dd_battletoads' in k:
        snap = data[k]
        print(f'{k}:')
        print(f'  keys: {list(snap.keys())}')
        for sk in snap:
            v = snap[sk]
            if isinstance(v, list): print(f'  {sk}: list[{len(v)}]')
            elif isinstance(v, dict): print(f'  {sk}: dict keys={list(v.keys())[:5]}')
            else: print(f'  {sk}: {v}')
        break
" 2>&1

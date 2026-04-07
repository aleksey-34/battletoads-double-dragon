#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== review_snapshots content ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.review_snapshots';" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
data = json.loads(raw)
if isinstance(data, dict):
    for k, snap in data.items():
        trades = snap.get('tradeLog', [])
        dd = [t for t in trades if 'DD_BattleToads' in t.get('strategyName','')]
        za = [t for t in trades if 'stat_arb' in t.get('strategyName','')]
        zz = [t for t in trades if 'zz_breakout' in t.get('strategyName','')]
        ep = snap.get('equityPoints',[])
        print(f'{k}: trades={len(trades)} (DD:{len(dd)}, SA:{len(za)}, ZZ:{len(zz)}), equity_pts={len(ep)}')
        if dd:
            reasons = {}
            for t in dd:
                reasons[t.get('reason','?')] = reasons.get(t.get('reason','?'),0)+1
            pnl = sum(t.get('netPnl',0) for t in dd)
            wins = sum(1 for t in dd if t.get('netPnl',0)>0)
            print(f'  DD: PnL=\${pnl:.2f}, W/L={wins}/{len(dd)-wins}, reasons={reasons}')
elif isinstance(data, list):
    print(f'Array of {len(data)} items')
    for i,item in enumerate(data[:3]):
        print(f'  [{i}]: keys={list(item.keys())[:10]}')
" 2>&1

echo ""
echo "=== ts_backtest_snapshots ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots';" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
data = json.loads(raw)
if isinstance(data, dict):
    for k, snap in data.items():
        trades = snap.get('tradeLog', [])
        dd = [t for t in trades if 'DD_BattleToads' in t.get('strategyName','')]
        za = [t for t in trades if 'stat_arb' in t.get('strategyName','')]
        zz = [t for t in trades if 'zz_breakout' in t.get('strategyName','')]
        ep = snap.get('equityPoints',[])
        print(f'{k}: trades={len(trades)} (DD:{len(dd)}, SA:{len(za)}, ZZ:{len(zz)}), equity_pts={len(ep)}')
        if dd:
            reasons = {}
            for t in dd:
                reasons[t.get('reason','?')] = reasons.get(t.get('reason','?'),0)+1
            pnl = sum(t.get('netPnl',0) for t in dd)
            wins = sum(1 for t in dd if t.get('netPnl',0)>0)
            print(f'  DD: PnL=\${pnl:.2f}, W/L={wins}/{len(dd)-wins}, reasons={reasons}')
" 2>&1

echo ""
echo "=== What symbols does the BTDD_D1 trading system actually use? ==="
sqlite3 database.db "
SELECT ts.name, s.id, s.base_symbol, s.quote_symbol, s.strategy_type, s.market_mode, s.is_active
FROM trading_system_members m
JOIN strategies s ON s.id = m.strategy_id
JOIN trading_systems ts ON ts.id = m.ts_id
WHERE ts.name LIKE '%btdd%' OR ts.name LIKE '%BTDD%'
ORDER BY s.strategy_type, s.base_symbol;
"

echo ""
echo "=== trading_system_members schema ==="
sqlite3 database.db "PRAGMA table_info(trading_system_members);"

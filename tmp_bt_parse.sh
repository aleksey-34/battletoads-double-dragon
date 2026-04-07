#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== All offer.store keys with sizes ==="
sqlite3 database.db "SELECT key, LENGTH(value) FROM app_runtime_flags WHERE key LIKE 'offer.store%' ORDER BY key;"

echo ""
echo "=== Parse DD_BattleToads from ts_backtest_snapshot (singular) ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshot';" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('EMPTY')
    sys.exit()
data = json.loads(raw)
for setKey, snap in data.items():
    trades = snap.get('tradeLog', [])
    dd_trades = [t for t in trades if 'DD_BattleToads' in t.get('strategyName','')]
    if dd_trades:
        print(f'\n=== SET: {setKey} ===')
        reasons = {}
        symbols = {}
        for t in dd_trades:
            r = t.get('reason','?')
            reasons[r] = reasons.get(r,0)+1
            sn = t['strategyName']
            symbols[sn] = symbols.get(sn,0)+1
        print(f'Total DD trades: {len(dd_trades)}')
        print('Exit reasons:')
        for r,c in sorted(reasons.items(), key=lambda x:-x[1]):
            print(f'  {r}: {c}')
        print('Strategies:')
        for s,c in sorted(symbols.items(), key=lambda x:-x[1]):
            print(f'  {s}: {c} trades')
        total_pnl = sum(t.get('netPnl',0) for t in dd_trades)
        wins = sum(1 for t in dd_trades if t.get('netPnl',0)>0)
        losses = len(dd_trades) - wins
        print(f'DD PnL: \${total_pnl:.2f}, Wins: {wins}, Losses: {losses}, WR: {100*wins/len(dd_trades):.0f}%')
        # Avg holding time
        import statistics
        hold_times = [(t['exitTime']-t['entryTime'])/3600000 for t in dd_trades if 'exitTime' in t and 'entryTime' in t]
        if hold_times:
            print(f'Avg hold time: {statistics.mean(hold_times):.1f}h, median: {statistics.median(hold_times):.1f}h')
" 2>&1

echo ""
echo "=== Now check the FULL snapshot JSON: how many sets, which have DD ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshot';" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
if not raw:
    print('EMPTY - checking ts_backtest_snapshots')
    sys.exit()
data = json.loads(raw)
for setKey, snap in data.items():
    trades = snap.get('tradeLog', [])
    strat_types = set()
    for t in trades:
        name = t.get('strategyName','')
        if 'DD_BattleToads' in name: strat_types.add('DD')
        elif 'stat_arb' in name: strat_types.add('StatArb')
        elif 'zz_breakout' in name: strat_types.add('ZZ')
    ep = snap.get('equityPoints',[])
    print(f'{setKey}: {len(trades)} trades, types={strat_types}, equity pts={len(ep)}, first={ep[0] if ep else \"?\"}, last={ep[-1] if ep else \"?\"}')
" 2>&1

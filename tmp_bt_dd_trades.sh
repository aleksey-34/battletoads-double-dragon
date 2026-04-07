#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== Backtest DD_BattleToads: which symbols and how many exits? ==="
sqlite3 database.db "
SELECT key, 
  json_extract(value, '$.trades') as total_trades
FROM app_runtime_flags 
WHERE key = 'offer.store.ts_backtest_snapshots';
" | head -3

echo ""
echo "=== Parse DD trades from backtest snapshot ==="
sqlite3 database.db "
SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots';
" | python3 -c "
import sys, json
raw = sys.stdin.read().strip()
# The value is JSON with set keys
if '|' in raw:
    raw = raw.split('|',1)[1] if raw.startswith('offer') else raw
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
        # PnL summary
        total_pnl = sum(t.get('netPnl',0) for t in dd_trades)
        wins = sum(1 for t in dd_trades if t.get('netPnl',0)>0)
        print(f'DD PnL: {total_pnl:.2f}, Wins: {wins}/{len(dd_trades)} ({100*wins/len(dd_trades):.0f}%)')
" 2>&1

echo ""
echo "=== LIVE DD symbols vs BACKTEST DD symbols ==="
echo "LIVE DD:"
sqlite3 database.db "
SELECT DISTINCT base_symbol || COALESCE('/'||quote_symbol,'') as pair, market_mode
FROM strategies 
WHERE strategy_type='DD_BattleToads' AND is_active=1 AND last_action NOT LIKE 'admin_bulk%'
ORDER BY pair;
"

#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "========== BACKTEST SNAPSHOTS (parsed) =========="
sqlite3 database.db "
SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshots';
" | python3 -c "
import json, sys
data = json.loads(sys.stdin.read().strip())
for name, snap in data.items():
    ep = snap.get('equityPoints', [])
    ep_len = len(ep) if isinstance(ep, list) else 0
    # find max drawdown period in equity curve
    if ep_len > 5:
        peak = ep[0]
        max_dd = 0
        dd_start = 0
        dd_end = 0
        cur_start = 0
        for i, val in enumerate(ep):
            if val > peak:
                peak = val
                cur_start = i
            dd = (peak - val) / peak * 100 if peak > 0 else 0
            if dd > max_dd:
                max_dd = dd
                dd_start = cur_start
                dd_end = i
        # find flat/loss periods
        flat_periods = 0
        for i in range(1, ep_len):
            if ep[i] <= ep[i-1]:
                flat_periods += 1
        print(f'{name}:')
        print(f'  ret={snap.get(\"totalReturnPercent\",\"?\")}, dd={snap.get(\"maxDrawdownPercent\",\"?\")}, pf={snap.get(\"profitFactor\",\"?\")}, trades={snap.get(\"tradesCount\",\"?\")}, wr={snap.get(\"winRate\",\"?\")}')
        print(f'  equityPoints={ep_len}, first={ep[0]:.1f}, last={ep[-1]:.1f}')
        print(f'  maxDD_in_curve={max_dd:.1f}% (idx {dd_start}-{dd_end})')
        print(f'  flat/down bars={flat_periods}/{ep_len} ({flat_periods/ep_len*100:.0f}%)')
        # show equity curve summary (every 20 points)
        step = max(1, ep_len // 15)
        curve = [f'{ep[i]:.0f}' for i in range(0, ep_len, step)]
        print(f'  curve(sampled): {\" -> \".join(curve)}')
    else:
        print(f'{name}: ret={snap.get(\"totalReturnPercent\")}, dd={snap.get(\"maxDrawdownPercent\")}, pf={snap.get(\"profitFactor\")}, trades={snap.get(\"tradesCount\")}, wr={snap.get(\"winRate\")}, eq_pts={ep_len}')
    print()
" 2>&1

echo ""
echo "========== DD_BattleToads entries that never exited (stuck?) =========="
sqlite3 database.db "
SELECT s.id, s.base_symbol, s.strategy_type, s.market_mode, s.state, s.entry_ratio,
  (SELECT COUNT(*) FROM live_trade_events lte WHERE lte.strategy_id=s.id AND lte.trade_type='entry') AS entries,
  (SELECT COUNT(*) FROM live_trade_events lte WHERE lte.strategy_id=s.id AND lte.trade_type='exit') AS exits
FROM strategies s
JOIN api_keys ak ON ak.id = s.api_key_id
WHERE ak.name='BTDD_D1' AND s.is_runtime=1 AND s.strategy_type='DD_BattleToads'
ORDER BY s.base_symbol;
"

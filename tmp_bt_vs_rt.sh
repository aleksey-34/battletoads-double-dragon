#!/bin/bash
cd /opt/battletoads-double-dragon/backend

echo "=== 1. DD_BattleToads runtime strategies: current state & params ==="
sqlite3 database.db "
SELECT s.id, s.base_symbol||COALESCE('/'||s.quote_symbol,'') as pair, 
       s.market_mode, s.state, s.entry_ratio, s.tp_anchor_ratio,
       s.take_profit_percent, s.price_channel_length, s.last_action
FROM strategies s
JOIN trading_system_members m ON m.strategy_id=s.id
JOIN trading_systems ts ON ts.id=m.trading_system_id
WHERE s.strategy_type='DD_BattleToads' AND ts.name LIKE '%btdd%'
ORDER BY s.id;
"

echo ""
echo "=== 2. Backtest snapshots: which sets contain DD_BattleToads? ==="
sqlite3 database.db "
SELECT key, 
       json_extract(value,'$.ret') as ret,
       json_extract(value,'$.dd') as dd,
       json_extract(value,'$.trades') as trades,
       json_extract(value,'$.tradesPerDay') as tpd
FROM app_runtime_flags
WHERE key LIKE 'offer.store.ts_backtest_snapshots%'
LIMIT 1;
" | head -5

echo ""
echo "=== 3. Backtest runs for DD_BattleToads strategies ==="
sqlite3 database.db "
SELECT br.id, br.strategy_id, s.base_symbol, s.strategy_type, s.market_mode,
       br.status, br.total_trades, br.win_rate, br.profit_factor, br.max_drawdown,
       br.created_at
FROM backtest_runs br
JOIN strategies s ON br.strategy_id=s.id
WHERE s.strategy_type='DD_BattleToads'
ORDER BY br.created_at DESC
LIMIT 20;
"

echo ""
echo "=== 4. Backtest predictions for DD strategies (exit events) ==="
sqlite3 database.db "
SELECT bp.backtest_run_id, bp.strategy_id, bp.trade_type, bp.side, bp.predicted_price, bp.predicted_time
FROM backtest_predictions bp
JOIN strategies s ON bp.strategy_id=s.id
WHERE s.strategy_type='DD_BattleToads'
ORDER BY bp.id DESC
LIMIT 30;
"

echo ""
echo "=== 5. How many entry vs exit in backtest_predictions for DD ==="
sqlite3 database.db "
SELECT s.strategy_type, bp.trade_type, COUNT(*)
FROM backtest_predictions bp
JOIN strategies s ON bp.strategy_id=s.id
WHERE s.strategy_type='DD_BattleToads'
GROUP BY s.strategy_type, bp.trade_type;
"

echo ""
echo "=== 6. How many bar_time!=actual (desync) entries for DD in live ==="
sqlite3 database.db "
SELECT s.id, s.base_symbol, s.market_mode,
       SUM(CASE WHEN lte.source_trade_id LIKE '%bar_time%' THEN 1 ELSE 0 END) as desync_entries,
       SUM(CASE WHEN lte.source_trade_id NOT LIKE '%bar_time%' OR lte.source_trade_id IS NULL THEN 1 ELSE 0 END) as real_entries,
       COUNT(*) as total
FROM live_trade_events lte
JOIN strategies s ON lte.strategy_id=s.id
WHERE s.strategy_type='DD_BattleToads'
GROUP BY s.id, s.base_symbol, s.market_mode;
"

echo ""
echo "=== 7. Check what memo field looks like in live_trade_events ==="
sqlite3 database.db "PRAGMA table_info(live_trade_events);" | grep -i memo
sqlite3 database.db "
SELECT lte.id, lte.strategy_id, lte.trade_type, lte.side, 
       lte.source_trade_id, lte.source_order_id
FROM live_trade_events lte
JOIN strategies s ON lte.strategy_id=s.id
WHERE s.strategy_type='DD_BattleToads'
ORDER BY lte.id DESC
LIMIT 10;
"

echo ""
echo "=== 8. Runtime log: last DD evaluations ==="
journalctl -u btdd-runtime --since '6 hours ago' --no-pager 2>/dev/null | grep -E '(80156|80159|80161|80163|80166|80170).*(donchian|trailing|anchor|exit|close|TP|SL)' | tail -20

echo ""
echo "=== 9. Runtime log: DD signal evaluations ==="
journalctl -u btdd-runtime --since '2 hours ago' --no-pager 2>/dev/null | grep -E '80159|80166' | tail -20

echo ""
echo "=== 10. Strategy 80166 (AUCTION mono, long, entry_ratio=4.659): what would TP be? ==="
echo "entry_ratio=4.659, tp=4%, anchor=4.731"
echo "trailing_stop = 4.731 * (1 - 4/100) = 4.731 * 0.96 = 4.54176"
echo "SL = donchianCenter. Need to know current donchian channel for AUCTIONUSDT 4h"

echo ""
echo "=== 11. Last 10 4h candles for AUCTIONUSDT ==="
# Check if there's a candle cache
ls -la /opt/battletoads-double-dragon/backend/candle_cache/ 2>/dev/null | grep -i auction | head -5

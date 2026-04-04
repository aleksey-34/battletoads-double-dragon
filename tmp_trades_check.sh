#!/bin/bash
DB="/opt/battletoads-double-dragon/backend/database.db"

echo "=== 1. LIVE TRADE EVENTS TABLE SCHEMA ==="
sqlite3 "$DB" ".schema live_trade_events" 2>/dev/null

echo ""
echo "=== 2. RECENT LIVE TRADE EVENTS (BTDD_D1) ==="
sqlite3 "$DB" "
SELECT * FROM live_trade_events
ORDER BY rowid DESC
LIMIT 20;
" 2>/dev/null

echo ""
echo "=== 3. SYNCTRADE SESSIONS ==="
sqlite3 "$DB" ".schema synctrade_sessions" 2>/dev/null
echo "---"
sqlite3 "$DB" "SELECT * FROM synctrade_sessions ORDER BY rowid DESC LIMIT 10;" 2>/dev/null

echo ""
echo "=== 4. SYNCTRADE PROFILES ==="
sqlite3 "$DB" ".schema synctrade_profiles" 2>/dev/null
echo "---"
sqlite3 "$DB" "SELECT * FROM synctrade_profiles LIMIT 10;" 2>/dev/null

echo ""
echo "=== 5. RECENT LOGS - TRADE EXECUTION ==="
grep -i 'order\|fill\|execute\|place.*order\|open.*position\|close.*position' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | tail -30

echo ""
echo "=== 6. RECENT LOGS - CYCLE/REBALANCE ==="
grep -i 'cycle\|rebalance\|signal\|strategy.*run\|tick' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | tail -20

echo ""
echo "=== 7. BTDD_D1 POSITIONS FROM EXCHANGE (check open positions) ==="
grep -i 'position\|notional\|BTDD_D1.*size\|BTDD_D1.*qty' /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | tail -15

echo ""
echo "=== 8. CURRENT NOTIONAL BREAKDOWN ==="
sqlite3 "$DB" "
SELECT ms.recorded_at, ms.equity_usd, ms.margin_used_usd, ms.notional_usd, ms.margin_load_percent, ms.effective_leverage
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ak.name = 'BTDD_D1' AND ms.equity_usd > 100
ORDER BY ms.recorded_at DESC
LIMIT 1;
"

echo ""
echo "=== DONE ==="

#!/bin/bash
# Deep dive: real trading activity on BTDD_D1
DB="/opt/battletoads-double-dragon/backend/database.db"

echo "=== 1. BTDD_D1 REAL BALANCE RIGHT NOW (from exchange) ==="
# Latest snapshot from api_key BTDD_D1
sqlite3 "$DB" "
SELECT equity_usd, unrealized_pnl, margin_used_usd, margin_load_percent, 
  effective_leverage, notional_usd, drawdown_percent, recorded_at
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ak.name = 'BTDD_D1'
ORDER BY ms.recorded_at DESC
LIMIT 5;
"

echo ""
echo "=== 2. ZERO-EQUITY SNAPSHOTS (bug?) ==="
sqlite3 "$DB" "
SELECT count(*) as zero_count, 
  min(recorded_at) as first_zero,
  max(recorded_at) as last_zero
FROM monitoring_snapshots
WHERE equity_usd = 0 OR equity_usd < 1;
"

echo ""
echo "=== 3. NON-ZERO EQUITY TREND (BTDD_D1 only, ignoring zeros) ==="
sqlite3 "$DB" "
SELECT date(ms.recorded_at) as day,
  round(min(ms.equity_usd),2) as min_eq,
  round(max(ms.equity_usd),2) as max_eq,
  round(avg(ms.equity_usd),2) as avg_eq,
  count(*) as pts
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ak.name = 'BTDD_D1' AND ms.equity_usd > 100
GROUP BY date(ms.recorded_at)
ORDER BY day DESC
LIMIT 30;
"

echo ""
echo "=== 4. HOW MANY API KEYS FEED INTO monitoring_snapshots? ==="
sqlite3 "$DB" "
SELECT ak.name, ms.api_key_id, count(*) as snapshot_count,
  round(max(ms.equity_usd),2) as max_eq,
  max(ms.recorded_at) as latest
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
GROUP BY ms.api_key_id
ORDER BY snapshot_count DESC;
"

echo ""
echo "=== 5. REAL POSITIONS RIGHT NOW ==="
# Check if there's a positions table or recent trade activity
sqlite3 "$DB" ".tables" 2>/dev/null | tr ' ' '\n' | grep -i 'position\|trade\|order\|signal\|execution'

echo ""
echo "=== 6. STRATEGY EXECUTION LOGS (recent) ==="
sqlite3 "$DB" "
SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%trade%' OR name LIKE '%order%' OR name LIKE '%signal%' OR name LIKE '%execution%' OR name LIKE '%position%');
"

echo ""
echo "=== 7. CHECK BTDD_D1 MARGIN LOAD HISTORY (is it trading at all?) ==="
sqlite3 "$DB" "
SELECT date(ms.recorded_at) as day,
  round(max(ms.margin_load_percent),4) as max_margin_load,
  round(avg(ms.margin_load_percent),4) as avg_margin_load,
  round(max(ms.effective_leverage),4) as max_leverage,
  round(max(ms.notional_usd),2) as max_notional
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ak.name = 'BTDD_D1' AND ms.equity_usd > 100
GROUP BY date(ms.recorded_at)
ORDER BY day DESC
LIMIT 30;
"

echo ""
echo "=== 8. CLIENT KEYS MARGIN LOAD (are clients actually trading?) ==="
sqlite3 "$DB" "
SELECT ak.name,
  round(max(ms.margin_load_percent),2) as max_ml,
  round(avg(CASE WHEN ms.margin_load_percent > 0 THEN ms.margin_load_percent END),2) as avg_ml_when_active,
  round(max(ms.effective_leverage),4) as max_lev,
  round(max(ms.notional_usd),2) as max_notional,
  count(CASE WHEN ms.margin_load_percent > 0.1 THEN 1 END) as active_snapshots,
  count(*) as total_snapshots
FROM monitoring_snapshots ms
JOIN api_keys ak ON ak.id = ms.api_key_id
WHERE ms.recorded_at >= datetime('now', '-7 days')
GROUP BY ak.name
ORDER BY max_ml DESC;
"

echo ""
echo "=== 9. BACKTEST vs REALITY COMPARISON ==="
echo "Backtest expectations (from snapshots):"
echo "  ts-multiset-v2-h6e6sh: +107% over 451 days = +0.237%/day = +0.024%/bar(4h)"
echo "  ts-curated-balanced-7-v1: +203% over 451 days = +0.45%/day"
echo ""
echo "Real BTDD_D1 performance (non-zero equity):"
sqlite3 "$DB" "
WITH ordered AS (
  SELECT ms.equity_usd, ms.recorded_at,
    ROW_NUMBER() OVER (ORDER BY ms.recorded_at ASC) as rn_asc,
    ROW_NUMBER() OVER (ORDER BY ms.recorded_at DESC) as rn_desc
  FROM monitoring_snapshots ms
  JOIN api_keys ak ON ak.id = ms.api_key_id
  WHERE ak.name = 'BTDD_D1' AND ms.equity_usd > 100
)
SELECT 
  (SELECT equity_usd FROM ordered WHERE rn_asc = 1) as first_equity,
  (SELECT recorded_at FROM ordered WHERE rn_asc = 1) as first_date,
  (SELECT equity_usd FROM ordered WHERE rn_desc = 1) as last_equity,
  (SELECT recorded_at FROM ordered WHERE rn_desc = 1) as last_date,
  round((SELECT equity_usd FROM ordered WHERE rn_desc = 1) - (SELECT equity_usd FROM ordered WHERE rn_asc = 1), 2) as pnl,
  round(((SELECT equity_usd FROM ordered WHERE rn_desc = 1) / (SELECT equity_usd FROM ordered WHERE rn_asc = 1) - 1) * 100, 4) as return_pct;
"

echo ""
echo "=== 10. APP LOGS - recent cycle activity ==="
ls -la /opt/battletoads-double-dragon/backend/logs/ 2>/dev/null | tail -5
echo "---"
tail -30 /opt/battletoads-double-dragon/backend/logs/combined.log 2>/dev/null | grep -i 'trade\|order\|signal\|position\|execution\|cycle\|rebalance' | tail -15

echo ""
echo "=== DONE ==="

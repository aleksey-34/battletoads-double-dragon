#!/bin/bash
# Diagnostic: Real trading performance vs backtest expectations
DB="/opt/battletoads-double-dragon/backend/database.db"

echo "=== 1. MONITORING SNAPSHOTS (last 30 days) ==="
sqlite3 "$DB" "
SELECT 
  date(recorded_at) as day,
  round(min(equity_usd),2) as min_eq,
  round(max(equity_usd),2) as max_eq,
  round(avg(equity_usd),2) as avg_eq,
  round(max(drawdown_percent),4) as max_dd,
  count(*) as pts
FROM monitoring_snapshots
WHERE recorded_at >= datetime('now', '-30 days')
GROUP BY date(recorded_at)
ORDER BY day DESC
LIMIT 30;
"

echo ""
echo "=== 2. MONITORING TREND (first vs last) ==="
sqlite3 "$DB" "
SELECT 'FIRST' as point, equity_usd, drawdown_percent, recorded_at
FROM monitoring_snapshots
WHERE recorded_at >= datetime('now', '-30 days')
ORDER BY recorded_at ASC LIMIT 1;
"
sqlite3 "$DB" "
SELECT 'LAST' as point, equity_usd, drawdown_percent, recorded_at  
FROM monitoring_snapshots
ORDER BY recorded_at DESC LIMIT 1;
"

echo ""
echo "=== 3. TOTAL MONITORING HISTORY ==="
sqlite3 "$DB" "
SELECT 
  count(*) as total_points,
  min(recorded_at) as first_record,
  max(recorded_at) as last_record,
  round(min(equity_usd),2) as all_time_min,
  round(max(equity_usd),2) as all_time_max
FROM monitoring_snapshots;
"

echo ""
echo "=== 4. ACTIVE TRADING SYSTEMS ==="
sqlite3 "$DB" "
SELECT ts.id, ts.name, ts.is_active, 
  (SELECT count(*) FROM trading_system_members tsm WHERE tsm.system_id = ts.id AND tsm.is_enabled = 1) as enabled_members
FROM trading_systems ts
WHERE ts.name LIKE 'ALGOFUND_MASTER%' AND ts.is_active = 1
ORDER BY ts.id;
"

echo ""
echo "=== 5. CONNECTED CLIENT SYSTEM ==="
sqlite3 "$DB" "
SELECT ap.tenant_id, ap.published_system_name, ap.actual_enabled, ap.risk_multiplier, ap.assigned_api_key_name
FROM algofund_profiles ap
WHERE ap.published_system_name != '' AND ap.published_system_name IS NOT NULL;
"

echo ""
echo "=== 6. API KEY BALANCES (from monitoring) ==="
sqlite3 "$DB" "
SELECT ak.name as api_key, 
  ms.equity_usd, ms.unrealized_pnl, ms.margin_load_percent, ms.drawdown_percent, ms.effective_leverage,
  ms.recorded_at
FROM api_keys ak
JOIN monitoring_snapshots ms ON ms.api_key_id = ak.id
WHERE ms.id IN (
  SELECT MAX(id) FROM monitoring_snapshots GROUP BY api_key_id
)
ORDER BY ak.name;
"

echo ""
echo "=== 7. EQUITY CHANGE OVER PERIODS ==="
sqlite3 "$DB" "
WITH periods AS (
  SELECT '7d' as period, datetime('now', '-7 days') as cutoff
  UNION ALL SELECT '14d', datetime('now', '-14 days')
  UNION ALL SELECT '30d', datetime('now', '-30 days')
),
latest AS (
  SELECT equity_usd FROM monitoring_snapshots ORDER BY recorded_at DESC LIMIT 1
),
period_start AS (
  SELECT p.period, 
    (SELECT equity_usd FROM monitoring_snapshots WHERE recorded_at >= p.cutoff ORDER BY recorded_at ASC LIMIT 1) as start_eq
  FROM periods p
)
SELECT ps.period, 
  round(ps.start_eq, 2) as start_equity,
  round(l.equity_usd, 2) as current_equity,
  round(l.equity_usd - ps.start_eq, 2) as pnl,
  round((l.equity_usd / ps.start_eq - 1) * 100, 4) as return_pct
FROM period_start ps, latest l;
"

echo ""
echo "=== 8. BACKTEST SNAPSHOT DATA (from runtime flags) ==="
python3 -c "
import json, sqlite3
db = sqlite3.connect('$DB')
row = db.execute(\"SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshots'\").fetchone()
if row:
    data = json.loads(row[0])
    for k, v in data.items():
        if isinstance(v, dict):
            pd = v.get('periodDays', '?')
            ret = v.get('ret', '?')
            dd = v.get('dd', '?')
            trades = v.get('trades', '?')
            settings = v.get('backtestSettings', {})
            risk = settings.get('riskScore', '?')
            freq = settings.get('tradeFrequencyScore', '?')
            init_bal = settings.get('initialBalance', '?')
            print(f'{k}:')
            print(f'  period={pd}d ret={ret}% dd={dd}% trades={trades}')
            print(f'  risk_score={risk} freq_score={freq} initial_bal={init_bal}')
else:
    print('NO SNAPSHOTS')
"

echo ""
echo "=== 9. RUNTIME STATE: IS TRADING ACTUALLY RUNNING? ==="
sqlite3 "$DB" "
SELECT key, substr(value, 1, 100) as val_preview
FROM app_runtime_flags
WHERE key LIKE 'runtime.cycle%';
"

echo ""
echo "=== DONE ==="

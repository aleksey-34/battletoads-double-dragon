-- TS margin baseline report
-- Run:
--   sqlite3 -header -column backend/database.db < scripts/ts_margin_baseline.sql

.print '=== 1) Observed margin load by active trading system (last 24h) ==='
WITH ts_key AS (
  SELECT ts.name AS ts_name, a.id AS api_key_id, a.name AS api_key_name
  FROM trading_systems ts
  JOIN api_keys a ON a.id = ts.api_key_id
  WHERE ts.is_active = 1
),
snap AS (
  SELECT tk.ts_name, tk.api_key_name, m.margin_load_percent, m.recorded_at
  FROM ts_key tk
  JOIN monitoring_snapshots m ON m.api_key_id = tk.api_key_id
  WHERE m.recorded_at >= datetime('now', '-24 hours')
)
SELECT
  ts_name,
  api_key_name,
  ROUND(AVG(margin_load_percent), 2) AS avg_margin_24h,
  ROUND(MAX(margin_load_percent), 2) AS max_margin_24h,
  ROUND(MIN(margin_load_percent), 2) AS min_margin_24h,
  COUNT(*) AS samples_24h
FROM snap
GROUP BY ts_name, api_key_name
ORDER BY avg_margin_24h DESC;

.print ''
.print '=== 2) Expected margin budget from strategy knobs (full deployment estimate) ==='
WITH latest_snap AS (
  SELECT m.api_key_id, m.equity_usd
  FROM monitoring_snapshots m
  JOIN (
    SELECT api_key_id, MAX(recorded_at) AS mx
    FROM monitoring_snapshots
    GROUP BY api_key_id
  ) x ON x.api_key_id = m.api_key_id AND x.mx = m.recorded_at
),
cfg AS (
  SELECT
    ts.name AS ts_name,
    a.name AS api_key_name,
    s.id AS strategy_id,
    COALESCE(s.max_deposit, 0) AS max_deposit,
    ((COALESCE(s.lot_long_percent, 100) + COALESCE(s.lot_short_percent, 100)) / 2.0) AS lot_avg_pct,
    COALESCE(s.reinvest_percent, 0) AS reinvest_pct,
    MAX(1.0, COALESCE(s.leverage, 1.0)) AS leverage,
    COALESCE(s.fixed_lot, 0) AS fixed_lot,
    ls.equity_usd
  FROM trading_systems ts
  JOIN api_keys a ON a.id = ts.api_key_id
  JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled, 1) = 1
  JOIN strategies s ON s.id = tsm.strategy_id
  JOIN latest_snap ls ON ls.api_key_id = a.id
  WHERE ts.is_active = 1
    AND s.is_active = 1
    AND COALESCE(s.is_archived, 0) = 0
),
per_member AS (
  SELECT
    ts_name,
    api_key_name,
    strategy_id,
    max_deposit,
    lot_avg_pct,
    reinvest_pct,
    leverage,
    fixed_lot,
    equity_usd,
    (
      CASE
        WHEN fixed_lot = 1 THEN CASE WHEN max_deposit > 0 THEN max_deposit ELSE equity_usd END
        ELSE CASE WHEN max_deposit > 0 THEN MIN(equity_usd, max_deposit) ELSE equity_usd END
      END
    )
    * (lot_avg_pct / 100.0)
    * (CASE WHEN fixed_lot = 1 THEN 1.0 ELSE 1.0 + MAX(0, reinvest_pct) / 100.0 END)
    / leverage AS margin_budget_est
  FROM cfg
)
SELECT
  ts_name,
  api_key_name,
  COUNT(*) AS members,
  ROUND(AVG(max_deposit), 2) AS avg_max_deposit,
  ROUND(AVG(lot_avg_pct), 2) AS avg_lot_pct,
  ROUND(AVG(reinvest_pct), 2) AS avg_reinvest_pct,
  ROUND(AVG(leverage), 2) AS avg_leverage,
  ROUND(SUM(100.0 * margin_budget_est / NULLIF(equity_usd, 0)), 3) AS ts_margin_pct_of_equity_est
FROM per_member
GROUP BY ts_name, api_key_name
ORDER BY ts_margin_pct_of_equity_est DESC;

.print ''
.print '=== 3) Account-level drift: observed latest vs expected from active strategies ==='
WITH latest_snap AS (
  SELECT m.api_key_id, m.equity_usd, m.margin_used_usd, m.margin_load_percent, m.recorded_at
  FROM monitoring_snapshots m
  JOIN (
    SELECT api_key_id, MAX(recorded_at) AS mx
    FROM monitoring_snapshots
    GROUP BY api_key_id
  ) x ON x.api_key_id = m.api_key_id AND x.mx = m.recorded_at
),
strat_base AS (
  SELECT
    s.id AS strategy_id,
    s.api_key_id,
    COALESCE(s.fixed_lot, 0) AS fixed_lot,
    COALESCE(s.max_deposit, 0) AS max_deposit,
    COALESCE(s.lot_long_percent, 100) AS lot_long_percent,
    COALESCE(s.lot_short_percent, 100) AS lot_short_percent,
    MAX(1.0, COALESCE(s.leverage, 1.0)) AS leverage,
    COALESCE(s.reinvest_percent, 0) AS reinvest_percent,
    ls.equity_usd
  FROM strategies s
  JOIN latest_snap ls ON ls.api_key_id = s.api_key_id
  WHERE s.is_active = 1
    AND COALESCE(s.is_archived, 0) = 0
),
strat_notional AS (
  SELECT
    strategy_id,
    api_key_id,
    leverage,
    (
      CASE
        WHEN fixed_lot = 1 THEN CASE WHEN max_deposit > 0 THEN max_deposit ELSE equity_usd END
        ELSE CASE WHEN max_deposit > 0 THEN MIN(equity_usd, max_deposit) ELSE equity_usd END
      END
    )
    * (((lot_long_percent + lot_short_percent) / 2.0) / 100.0)
    * (CASE WHEN fixed_lot = 1 THEN 1.0 ELSE 1.0 + MAX(0, reinvest_percent) / 100.0 END)
    AS notional_est
  FROM strat_base
),
agg AS (
  SELECT
    api_key_id,
    SUM(notional_est / leverage) AS margin_est_sum
  FROM strat_notional
  GROUP BY api_key_id
)
SELECT
  a.name AS api_key_name,
  ROUND(ls.margin_load_percent, 2) AS margin_pct_actual,
  ROUND(CASE WHEN ls.equity_usd > 0 THEN 100.0 * COALESCE(agg.margin_est_sum, 0) / ls.equity_usd ELSE 0 END, 2) AS margin_pct_expected,
  ROUND(ls.margin_load_percent - (CASE WHEN ls.equity_usd > 0 THEN 100.0 * COALESCE(agg.margin_est_sum, 0) / ls.equity_usd ELSE 0 END), 2) AS drift_pct
FROM api_keys a
JOIN latest_snap ls ON ls.api_key_id = a.id
LEFT JOIN agg ON agg.api_key_id = a.id
WHERE ls.equity_usd > 0
ORDER BY drift_pct DESC;

SELECT 'LIVE_TRADES_48H' AS section;
SELECT lte.id,
       lte.strategy_id,
       s.name,
       lte.side,
       lte.trade_type,
       datetime(lte.entry_time/1000, 'unixepoch') AS entry_utc
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name = 'Mehmet_Bingx')
  AND lte.entry_time >= (strftime('%s','now','-48 hours') * 1000)
ORDER BY lte.id DESC
LIMIT 50;

SELECT 'MEHMET_BTDD_D1_STRATEGIES' AS section;
SELECT id, name, is_active, updated_at
FROM strategies
WHERE api_key_id = (SELECT id FROM api_keys WHERE name = 'Mehmet_Bingx')
  AND UPPER(name) LIKE '%BTDD_D1%'
ORDER BY id DESC;

SELECT 'MONITORING_COVERAGE' AS section;
SELECT MIN(recorded_at) AS first_snapshot,
       MAX(recorded_at) AS last_snapshot,
       COUNT(*) AS snapshots
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name = 'Mehmet_Bingx');

SELECT 'MONITORING_LAST_10' AS section;
SELECT recorded_at,
       ROUND(equity_usd, 4) AS equity_usd,
       ROUND(margin_load_percent, 4) AS margin_load_percent,
       ROUND(effective_leverage, 4) AS effective_leverage,
       ROUND(drawdown_percent, 4) AS drawdown_percent
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name = 'Mehmet_Bingx')
ORDER BY datetime(recorded_at) DESC
LIMIT 10;

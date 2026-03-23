SELECT 'BTDD_D1_API_KEY' AS section;
SELECT id, name, exchange
FROM api_keys
WHERE name = 'BTDD_D1';

SELECT 'BTDD_D1_SYSTEMS' AS section;
SELECT ts.id, ts.name, ts.is_active, ts.updated_at
FROM trading_systems ts
WHERE ts.api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
ORDER BY ts.id DESC
LIMIT 20;

SELECT 'BTDD_D1_STRATEGIES_ACTIVE' AS section;
SELECT s.id, s.name, s.is_active, s.updated_at
FROM strategies s
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
  AND s.is_active = 1
ORDER BY s.id DESC
LIMIT 50;

SELECT 'BTDD_D1_LIVE_TRADES_48H' AS section;
SELECT lte.id,
       lte.strategy_id,
       s.name,
       lte.side,
       lte.trade_type,
       datetime(lte.entry_time/1000, 'unixepoch') AS entry_utc
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
  AND lte.entry_time >= (strftime('%s','now','-48 hours') * 1000)
ORDER BY lte.id DESC
LIMIT 100;

SELECT 'BTDD_D1_MONITORING_LAST_10' AS section;
SELECT recorded_at,
       ROUND(equity_usd, 4) AS equity_usd,
       ROUND(margin_load_percent, 4) AS margin_load_percent,
       ROUND(effective_leverage, 4) AS effective_leverage,
       ROUND(drawdown_percent, 4) AS drawdown_percent
FROM monitoring_snapshots
WHERE api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
ORDER BY datetime(recorded_at) DESC
LIMIT 10;

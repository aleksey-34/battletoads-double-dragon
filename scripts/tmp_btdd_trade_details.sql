SELECT 'BTDD_EVENTS_ALL_72H' AS section;
SELECT lte.id,
       lte.strategy_id,
       s.name,
       lte.trade_type,
       lte.side,
       datetime(lte.entry_time/1000, 'unixepoch') AS signal_time_utc,
       datetime(lte.actual_time/1000, 'unixepoch') AS exec_time_utc,
       ROUND(lte.entry_price, 6) AS signal_price,
       ROUND(lte.actual_price, 6) AS exec_price,
       ROUND(lte.position_size, 6) AS position_size,
       ROUND(lte.actual_fee, 6) AS actual_fee,
       ROUND(lte.slippage_percent, 6) AS slippage_percent,
       lte.source_symbol
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
  AND lte.actual_time >= (strftime('%s','now','-72 hours') * 1000)
ORDER BY lte.actual_time DESC;

SELECT 'BTDD_EVENTS_BY_STRATEGY' AS section;
SELECT lte.strategy_id,
       s.name,
       SUM(CASE WHEN lte.trade_type = 'entry' THEN 1 ELSE 0 END) AS entries,
       SUM(CASE WHEN lte.trade_type = 'exit' THEN 1 ELSE 0 END) AS exits,
       ROUND(SUM(lte.actual_fee), 6) AS total_fees
FROM live_trade_events lte
JOIN strategies s ON s.id = lte.strategy_id
WHERE s.api_key_id = (SELECT id FROM api_keys WHERE name = 'BTDD_D1')
  AND lte.actual_time >= (strftime('%s','now','-72 hours') * 1000)
GROUP BY lte.strategy_id, s.name
ORDER BY entries DESC, exits DESC;

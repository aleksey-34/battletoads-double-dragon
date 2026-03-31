.headers on
.mode column
SELECT ts.id, ts.name, tsm.strategy_id, tsm.is_enabled, tsm.weight
FROM trading_systems ts
JOIN trading_system_members tsm ON tsm.system_id = ts.id
WHERE ts.name = 'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v'
ORDER BY tsm.id;

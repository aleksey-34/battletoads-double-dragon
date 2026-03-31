.headers on
.mode column
SELECT 'ACTIVE_SYSTEM' AS section, ts.id, ts.name, ak.name AS api_key_name, ts.is_active, COUNT(tsm.id) AS members
FROM trading_systems ts
LEFT JOIN api_keys ak ON ak.id = ts.api_key_id
LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
WHERE ts.name = 'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v'
GROUP BY ts.id, ts.name, ak.name, ts.is_active;

SELECT 'CLIENTS' AS section, t.id, t.display_name, ap.published_system_name, ap.actual_enabled, ap.requested_enabled,
       COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id = t.id
WHERE ap.published_system_name = 'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v';

SELECT 'RUNTIME_FLAG' AS section, key, substr(value,1,400) AS value_prefix
FROM app_runtime_flags
WHERE key IN ('offer.store.ts_backtest_snapshots','offer.store.ts_backtest_snapshot','offer.store.published_ids')
ORDER BY key;

SELECT 'MASTER_SYSTEMS' AS section, ts.name, COUNT(tsm.id) AS members
FROM trading_systems ts
LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
WHERE ts.name LIKE 'ALGOFUND_MASTER::BTDD_D1::%'
GROUP BY ts.name
ORDER BY ts.name;

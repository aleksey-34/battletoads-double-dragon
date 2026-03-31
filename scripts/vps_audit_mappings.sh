#!/usr/bin/env bash
set -euo pipefail
DB=/opt/battletoads-double-dragon/backend/database.db

sqlite3 -header -column "$DB" <<'SQL'
SELECT t.id AS tenant_id, t.display_name, t.slug, t.product_mode,
       ap.id AS profile_id,
       ap.assigned_api_key_name AS profile_assigned_api,
       ap.execution_api_key_name AS profile_execution_api,
       ap.published_system_name,
       t.assigned_api_key_name AS tenant_assigned_api,
       t.updated_at
FROM tenants t
LEFT JOIN algofund_profiles ap ON ap.tenant_id=t.id
WHERE t.product_mode='algofund_client'
ORDER BY t.id;
SQL

echo '--- api_keys ---'
sqlite3 -header -column "$DB" <<'SQL'
SELECT id,name,exchange,speed_limit,testnet,demo
FROM api_keys
ORDER BY id;
SQL

echo '--- trading_systems masters ---'
sqlite3 -header -column "$DB" <<'SQL'
SELECT id,name,api_key_id,is_active,updated_at
FROM trading_systems
WHERE name LIKE 'ALGOFUND_MASTER::%'
ORDER BY id;
SQL

echo '--- algofund_active_systems ---'
sqlite3 -header -column "$DB" <<'SQL'
SELECT aas.id, aas.profile_id, t.display_name, aas.system_name, aas.weight, aas.is_enabled, aas.assigned_by, aas.updated_at
FROM algofund_active_systems aas
LEFT JOIN algofund_profiles ap ON ap.id=aas.profile_id
LEFT JOIN tenants t ON t.id=ap.tenant_id
ORDER BY aas.profile_id, aas.id;
SQL

echo '--- monitoring_snapshots latest per api_key_id ---'
sqlite3 -header -column "$DB" <<'SQL'
WITH latest AS (
  SELECT api_key_id, MAX(recorded_at) AS max_recorded
  FROM monitoring_snapshots
  GROUP BY api_key_id
)
SELECT m.api_key_id, ak.name AS api_key_name, m.recorded_at, m.equity_usd, m.margin_load_percent
FROM monitoring_snapshots m
JOIN latest l ON l.api_key_id=m.api_key_id AND l.max_recorded=m.recorded_at
LEFT JOIN api_keys ak ON ak.id=m.api_key_id
ORDER BY m.api_key_id;
SQL

#!/usr/bin/env bash
set -euo pipefail

DB="/opt/battletoads-double-dragon/backend/database.db"
TS="$(date -u +%Y%m%dT%H%M%SZ)"
BK="/opt/battletoads-double-dragon/backend/database.db.pre_api_sync_${TS}.bak"

cp "$DB" "$BK"
echo "BACKUP:$BK"

echo "--- BEFORE MISMATCH ---"
sqlite3 -header -column "$DB" "
SELECT
  t.id AS tenant_id,
  t.display_name,
  t.assigned_api_key_name AS tenant_api,
  COALESCE(ap.assigned_api_key_name,'') AS profile_api,
  COALESCE(ap.execution_api_key_name,'') AS exec_api
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id = t.id
WHERE t.product_mode = 'algofund_client'
  AND (
    COALESCE(ap.assigned_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
    OR COALESCE(ap.execution_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
  )
ORDER BY t.id;
"

sqlite3 "$DB" "
BEGIN;
UPDATE algofund_profiles
SET
  assigned_api_key_name = (
    SELECT COALESCE(NULLIF(t.assigned_api_key_name, ''), algofund_profiles.assigned_api_key_name)
    FROM tenants t
    WHERE t.id = algofund_profiles.tenant_id
  ),
  execution_api_key_name = (
    SELECT COALESCE(NULLIF(t.assigned_api_key_name, ''), algofund_profiles.execution_api_key_name)
    FROM tenants t
    WHERE t.id = algofund_profiles.tenant_id
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE tenant_id IN (
  SELECT t.id
  FROM tenants t
  WHERE t.product_mode = 'algofund_client'
    AND COALESCE(NULLIF(t.assigned_api_key_name, ''), '') <> ''
)
AND (
  COALESCE(assigned_api_key_name,'') <> (
    SELECT COALESCE(t.assigned_api_key_name, '')
    FROM tenants t
    WHERE t.id = algofund_profiles.tenant_id
  )
  OR COALESCE(execution_api_key_name,'') <> (
    SELECT COALESCE(t.assigned_api_key_name, '')
    FROM tenants t
    WHERE t.id = algofund_profiles.tenant_id
  )
);
COMMIT;
"

echo "--- AFTER MISMATCH ---"
sqlite3 -header -column "$DB" "
SELECT
  t.id AS tenant_id,
  t.display_name,
  t.assigned_api_key_name AS tenant_api,
  COALESCE(ap.assigned_api_key_name,'') AS profile_api,
  COALESCE(ap.execution_api_key_name,'') AS exec_api
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id = t.id
WHERE t.product_mode = 'algofund_client'
  AND (
    COALESCE(ap.assigned_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
    OR COALESCE(ap.execution_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
  )
ORDER BY t.id;
"

echo "--- TARGET TENANTS NOW ---"
sqlite3 -header -column "$DB" "
SELECT
  t.id AS tenant_id,
  t.display_name,
  t.assigned_api_key_name AS tenant_api,
  ap.assigned_api_key_name AS profile_api,
  ap.execution_api_key_name AS exec_api
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id = t.id
WHERE t.display_name IN ('Ali', 'Ruslan')
ORDER BY t.id;
"

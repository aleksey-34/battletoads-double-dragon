#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

same_tenant = [
    dict(r)
    for r in cur.execute(
        """
        SELECT t.id AS tenant_id, t.slug, t.product_mode,
               scp.requested_enabled AS sc_requested, ap.requested_enabled AS ap_requested,
               scp.assigned_api_key_name AS strategy_key,
               ap.assigned_api_key_name AS algofund_key
        FROM tenants t
        JOIN strategy_client_profiles scp ON scp.tenant_id = t.id
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE TRIM(COALESCE(scp.assigned_api_key_name, '')) <> ''
          AND TRIM(COALESCE(ap.assigned_api_key_name, '')) <> ''
          AND scp.assigned_api_key_name = ap.assigned_api_key_name
        ORDER BY t.id
        """
    ).fetchall()
]

cross_tenant = [
    dict(r)
    for r in cur.execute(
        """
        WITH all_keys AS (
          SELECT assigned_api_key_name AS api_key_name, tenant_id, 'strategy' AS source
          FROM strategy_client_profiles
          WHERE TRIM(COALESCE(assigned_api_key_name, '')) <> ''
          UNION ALL
          SELECT assigned_api_key_name AS api_key_name, tenant_id, 'algofund' AS source
          FROM algofund_profiles
          WHERE TRIM(COALESCE(assigned_api_key_name, '')) <> ''
        )
        SELECT api_key_name,
               COUNT(*) AS usage_rows,
               COUNT(DISTINCT tenant_id) AS distinct_tenants,
               GROUP_CONCAT(DISTINCT tenant_id) AS tenant_ids
        FROM all_keys
        GROUP BY api_key_name
        HAVING COUNT(DISTINCT tenant_id) > 1
        ORDER BY distinct_tenants DESC, usage_rows DESC
        """
    ).fetchall()
]

print(json.dumps({"sameTenantSharedKey": same_tenant, "crossTenantConflicts": cross_tenant}, ensure_ascii=False, indent=2))
con.close()

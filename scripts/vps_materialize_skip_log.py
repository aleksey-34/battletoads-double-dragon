#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TENANTS = [41170, 41232, 69181]

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = [
    dict(r)
    for r in cur.execute(
        """
        SELECT id, tenant_id, action, payload_json, created_at
        FROM saas_audit_log
        WHERE tenant_id IN (%s)
          AND action IN ('saas_materialize_pair_unavailable','saas_materialize_reuse_conflict','saas_materialize')
        ORDER BY id DESC
        LIMIT 200
        """ % ",".join("?" for _ in TENANTS),
        TENANTS,
    ).fetchall()
]

for r in rows:
    try:
        r["payload"] = json.loads(r.get("payload_json") or "{}")
    except Exception:
        r["payload"] = {"raw": r.get("payload_json")}

print(json.dumps(rows, ensure_ascii=False, indent=2))
con.close()

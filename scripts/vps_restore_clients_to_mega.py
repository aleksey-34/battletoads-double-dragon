#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TENANTS = [41170, 41232, 69181]
TARGET = "ALGOFUND_MASTER::BTDD_D1::mega-portfolio"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

cur.execute(
    "UPDATE algofund_profiles SET published_system_name = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id IN (%s)" % ",".join("?" for _ in TENANTS),
    (TARGET, *TENANTS),
)
con.commit()

rows = [
    dict(r)
    for r in cur.execute(
        "SELECT tenant_id, published_system_name, requested_enabled, actual_enabled FROM algofund_profiles WHERE tenant_id IN (%s) ORDER BY tenant_id"
        % ",".join("?" for _ in TENANTS),
        TENANTS,
    ).fetchall()
]

print(json.dumps({"ok": True, "target": TARGET, "rows": rows}, ensure_ascii=False, indent=2))
con.close()

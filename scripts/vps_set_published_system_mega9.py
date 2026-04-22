#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TENANTS = [41170, 41232, 69181]
TARGET_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::algofund-master-btdd-d1-gs3-mega-9-9938uu"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

exists = cur.execute("SELECT id FROM trading_systems WHERE name = ? LIMIT 1", (TARGET_SYSTEM,)).fetchone()
if not exists:
    print(json.dumps({"ok": False, "error": "target_not_found", "target": TARGET_SYSTEM}, ensure_ascii=False, indent=2))
    raise SystemExit(0)

cur.execute(
    "UPDATE algofund_profiles SET published_system_name = ?, updated_at = CURRENT_TIMESTAMP WHERE tenant_id IN (%s)" % ",".join("?" for _ in TENANTS),
    (TARGET_SYSTEM, *TENANTS),
)
con.commit()

rows = [dict(r) for r in cur.execute(
    "SELECT tenant_id, published_system_name FROM algofund_profiles WHERE tenant_id IN (%s) ORDER BY tenant_id" % ",".join("?" for _ in TENANTS),
    TENANTS,
).fetchall()]

print(json.dumps({"ok": True, "target": TARGET_SYSTEM, "rows": rows}, ensure_ascii=False, indent=2))
con.close()

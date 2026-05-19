#!/usr/bin/env python3
import sqlite3, requests, os

DB = "/opt/battletoads-double-dragon/backend/database.db"
API = "http://localhost:3001"
TOKEN = os.environ.get("BTDD_ADMIN_TOKEN", "BattleToads2026!Ax")

HEADERS = {
    "Authorization": f"Bearer {TOKEN}",
    "Content-Type": "application/json",
}

conn = sqlite3.connect(DB)
rows = conn.execute("""
    SELECT t.id, t.slug FROM tenants t
    JOIN algofund_profiles ap ON ap.tenant_id = t.id
    WHERE ap.published_system_name LIKE '%balanced-portfolio%'
    AND ap.requested_enabled = 1
""").fetchall()

print(f"Found {len(rows)} tenants")
for tid, slug in rows:
    url = f"{API}/api/saas/algofund/{tid}/retry-materialize"
    try:
        r = requests.post(url, headers=HEADERS, timeout=60)
        print(f"  {slug} ({tid}): HTTP {r.status_code}")
        if r.status_code != 200:
            print(f"    Error: {r.text[:200]}")
    except Exception as e:
        print(f"  {slug} ({tid}): ERROR {e}")
print("Done")
conn.close()

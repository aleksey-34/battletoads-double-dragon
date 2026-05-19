#!/usr/bin/env python3
"""Materialize balanced-portfolio-v2 to all tenants via API (has DB context)."""
import sqlite3, requests, sys

DB = "/opt/battletoads-double-dragon/backend/database.db"
API = "http://localhost:4000"

conn = sqlite3.connect(DB)
rows = conn.execute("""
  SELECT t.id, t.slug FROM tenants t
  JOIN algofund_profiles ap ON ap.tenant_id = t.id
  WHERE ap.published_system_name = 'ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2'
  AND ap.requested_enabled = 1
""").fetchall()

print(f"Found {len(rows)} tenants to materialize")

for tid, slug in rows:
    url = f"{API}/api/saas/algofund/{tid}/retry-materialize"
    try:
        r = requests.post(url, timeout=30)
        print(f"  {slug} ({tid}): HTTP {r.status_code} - {r.text[:150]}")
    except Exception as e:
        print(f"  {slug} ({tid}): ERROR {e}")

print("Done")
conn.close()

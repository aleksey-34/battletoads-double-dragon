#!/usr/bin/env python3
import sqlite3, requests, os, time

DB = "/opt/battletoads-double-dragon/backend/database.db"
API = "http://localhost:3001"
TOKEN = os.environ.get("BTDD_ADMIN_TOKEN", "BattleToads2026!Ax")
TIMEOUT = 180
DELAY = 2

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
    ORDER BY t.id
""").fetchall()
conn.close()

print(f"Found {len(rows)} tenants, timeout={TIMEOUT}s, delay={DELAY}s")
ok, fail = [], []

for i, (tid, slug) in enumerate(rows):
    url = f"{API}/api/saas/algofund/{tid}/retry-materialize"
    print(f"[{i+1}/{len(rows)}] {slug} ({tid}) ... ", end="", flush=True)
    try:
        r = requests.post(url, headers=HEADERS, timeout=TIMEOUT)
        if r.status_code == 200:
            data = r.json()
            engine = data.get("engine", {})
            print(f"OK (engine={engine.get('systemName', 'none')})")
            ok.append(slug)
        else:
            print(f"FAIL HTTP {r.status_code}: {r.text[:150]}")
            fail.append((slug, tid, r.status_code, r.text[:150]))
    except requests.Timeout:
        print(f"TIMEOUT ({TIMEOUT}s)")
        fail.append((slug, tid, "TIMEOUT", f"exceeded {TIMEOUT}s"))
    except Exception as e:
        print(f"ERROR: {e}")
        fail.append((slug, tid, "ERROR", str(e)))

    if i < len(rows) - 1:
        time.sleep(DELAY)

print(f"\n=== SUMMARY: {len(ok)} OK, {len(fail)} FAILED ===")
for slug, tid, code, msg in fail:
    print(f"  {slug} ({tid}): {code} - {msg}")
print("Done")
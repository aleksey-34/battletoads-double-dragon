import urllib.request, json

def api(path):
    req = urllib.request.Request(f"http://localhost:3001/api{path}", method="GET")
    with urllib.request.urlopen(req, timeout=15) as resp:
        return json.loads(resp.read())

# 1. Get tables with profile/plan/tenant/algofund
import sqlite3
db = sqlite3.connect("/opt/battletoads-double-dragon/backend/database.db")
cur = db.cursor()

print("=== TABLES ===")
cur.execute("SELECT name FROM sqlite_master WHERE type='table'")
for r in cur.fetchall():
    if any(k in r[0].lower() for k in ['profile','plan','tenant','algofund','subscription']):
        print(r[0])

# 2. algofund_profiles
print("\n=== ALGOFUND_PROFILES schema ===")
cur.execute("PRAGMA table_info(algofund_profiles)")
for r in cur.fetchall():
    print(f"  {r[1]} ({r[2]})")

print("\n=== ALGOFUND_PROFILES data ===")
cur.execute("SELECT * FROM algofund_profiles")
cols = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(cols, row))
    print(json.dumps(d, default=str)[:500])

# 3. saas_plans
print("\n=== SAAS_PLANS ===")
try:
    cur.execute("SELECT * FROM saas_plans")
    cols = [d[0] for d in cur.description]
    for row in cur.fetchall():
        d = dict(zip(cols, row))
        print(json.dumps(d, default=str)[:300])
except:
    print("no saas_plans table")

# 4. strategy_client_profiles
print("\n=== STRATEGY_CLIENT_PROFILES ===")
try:
    cur.execute("SELECT * FROM strategy_client_profiles")
    cols = [d[0] for d in cur.description]
    for row in cur.fetchall():
        d = dict(zip(cols, row))
        print(json.dumps(d, default=str)[:300])
except Exception as e:
    print(f"no strategy_client_profiles: {e}")

# 5. Get tenant/subscription info
print("\n=== TENANTS ===")
try:
    cur.execute("SELECT * FROM tenants LIMIT 10")
    cols = [d[0] for d in cur.description]
    for row in cur.fetchall():
        d = dict(zip(cols, row))
        print(json.dumps(d, default=str)[:300])
except Exception as e:
    print(f"no tenants: {e}")

db.close()

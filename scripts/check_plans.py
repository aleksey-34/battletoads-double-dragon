import sqlite3, json

db = sqlite3.connect("/opt/battletoads-double-dragon/backend/database.db")
cur = db.cursor()

# Plans table
print("=== PLANS schema ===")
cur.execute("PRAGMA table_info(plans)")
for r in cur.fetchall():
    print(f"  {r[1]} ({r[2]})")

print("\n=== PLANS data ===")
cur.execute("SELECT * FROM plans")
cols = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(cols, row))
    # Trim large fields
    for k in d:
        if isinstance(d[k], str) and len(d[k]) > 100:
            d[k] = d[k][:100] + "..."
    print(json.dumps(d, default=str))

# Subscriptions
print("\n=== SUBSCRIPTIONS data ===")
cur.execute("SELECT * FROM subscriptions")
cols = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(cols, row))
    for k in d:
        if isinstance(d[k], str) and len(d[k]) > 100:
            d[k] = d[k][:100] + "..."
    print(json.dumps(d, default=str))

# algofund_profiles with tenant info
print("\n=== PROFILES + TENANT + PLAN ===")
cur.execute("""
    SELECT 
        p.id, t.slug, t.display_name, p.risk_multiplier, 
        p.execution_api_key_name,
        p.actual_enabled,
        s.plan_code,
        pl.max_deposit_total,
        pl.risk_cap_max,
        pl.max_strategies_total
    FROM algofund_profiles p
    JOIN tenants t ON p.tenant_id = t.id
    LEFT JOIN subscriptions s ON s.tenant_id = t.id AND s.status='active'
    LEFT JOIN plans pl ON s.plan_code = pl.code
    WHERE p.actual_enabled = 1
""")
cols = [d[0] for d in cur.description]
for row in cur.fetchall():
    d = dict(zip(cols, row))
    print(json.dumps(d, default=str))

db.close()

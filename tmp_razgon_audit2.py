import sqlite3, json, os

# Check razgon_config.json
cfg_path = '/opt/battletoads-double-dragon/backend/razgon_config.json'
if os.path.exists(cfg_path):
    with open(cfg_path) as f:
        data = json.load(f)
    print("=== razgon_config.json ===")
    print(json.dumps(data, indent=2))
else:
    print("razgon_config.json: NOT FOUND")

# All app_runtime_flags
DB = '/opt/battletoads-double-dragon/backend/database.db'
c = sqlite3.connect(DB)
print("\n=== app_runtime_flags (all) ===")
for r in c.execute("SELECT key, value FROM app_runtime_flags ORDER BY key").fetchall():
    val = r[1]
    if len(val) > 150:
        val = val[:147] + '...'
    print(f"  {r[0]}: {val}")

# Check BTDD_M1 strategies (all, not just active)
print("\n=== BTDD_M1 all strategies (last 20) ===")
for r in c.execute("""
    SELECT s.id, s.name, s.is_active, s.state, s.strategy_type
    FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
    WHERE ak.name='BTDD_M1'
    ORDER BY s.id DESC LIMIT 20
""").fetchall():
    print(f"  id={r[0]} {r[1][:60]} active={r[2]} state={r[3]} type={r[4]}")

# Check BTDD_D1 all strategies (all active=1)
print("\n=== BTDD_D1 all active strategies ===")
for r in c.execute("""
    SELECT s.id, s.name, s.is_active, s.state, s.strategy_type
    FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
    WHERE ak.name='BTDD_D1' AND s.is_active=1
    ORDER BY s.id DESC
""").fetchall():
    print(f"  id={r[0]} {r[1][:70]} state={r[3]} type={r[4]}")

c.close()

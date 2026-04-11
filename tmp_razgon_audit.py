import sqlite3, json
DB = '/opt/battletoads-double-dragon/backend/database.db'
c = sqlite3.connect(DB)

print("=== RAZGON trading_systems ===")
for r in c.execute("""
    SELECT ts.id, ak.name, ts.name, ts.is_active
    FROM trading_systems ts JOIN api_keys ak ON ak.id=ts.api_key_id
    WHERE UPPER(ts.name) LIKE '%RAZGON%' OR UPPER(ts.name) LIKE '%MOMENTUM%' OR UPPER(ts.name) LIKE '%SNIPER%'
    ORDER BY ts.id
""").fetchall():
    print(f"  TS#{r[0]} key={r[1]} name={r[2]} active={r[3]}")

print("\n=== RAZGON strategies (all api_keys) ===")
for r in c.execute("""
    SELECT s.id, ak.name, s.name, s.is_active, s.state
    FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
    WHERE UPPER(s.name) LIKE '%RAZGON%' OR UPPER(s.name) LIKE '%MOMENTUM%'
       OR s.strategy_type = 'momentum' OR s.strategy_type = 'razgon'
    ORDER BY ak.id, s.id
""").fetchall():
    print(f"  id={r[0]} key={r[1]} {r[2]} active={r[3]} state={r[4]}")

print("\n=== strategies columns ===")
cols = [r[1] for r in c.execute("PRAGMA table_info(strategies)").fetchall()]
print(f"  {cols}")

print("\n=== razgon_config flag ===")
for r in c.execute("SELECT key, SUBSTR(value,1,200) FROM app_runtime_flags WHERE key LIKE '%razgon%' OR key LIKE '%momentum%'").fetchall():
    print(f"  {r[0]}: {r[1]}")

print("\n=== btdd-api strategies (BTDD_M1/BTDD_D1) active ===")
for r in c.execute("""
    SELECT s.id, ak.name, s.name, s.is_active, s.state
    FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
    WHERE ak.name IN ('BTDD_M1','BTDD_D1') AND s.is_active=1
    ORDER BY ak.id, s.id DESC LIMIT 30
""").fetchall():
    print(f"  id={r[0]} key={r[1]} {r[2][:70]} state={r[4]}")

print("\n=== BTDD_M1 ALL active strategies ===")
for r in c.execute("""
    SELECT s.id, s.name, s.is_active, s.state, s.base_symbol, s.quote_symbol
    FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
    WHERE ak.name='BTDD_M1' AND s.is_active=1
    ORDER BY s.id
""").fetchall():
    print(f"  id={r[0]} {r[1][:60]} state={r[3]} {r[4]}/{r[5]}")

c.close()

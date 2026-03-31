#!/usr/bin/env python3
import sqlite3
import json
from datetime import datetime

DB = "/opt/battletoads-double-dragon/backend/database.db"
TS_ID = 25
ORIGINAL_NAME = "ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v"

con = sqlite3.connect(DB)
cur = con.cursor()

# 1. Check current state
print("=== CURRENT STATE ===")
cur.execute("SELECT id, name, is_active FROM trading_systems WHERE id = ?", [TS_ID])
row = cur.fetchone()
if row:
    print(f"ID: {row[0]}, Name: {row[1]}, Active: {row[2]}")
else:
    print("System not found")
    con.close()
    exit(1)

# 2. Restore name and activate
print("\n=== RESTORING ===")
cur.execute(
    "UPDATE trading_systems SET name = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?",
    [ORIGINAL_NAME, TS_ID]
)
con.commit()
print(f"Updated: name={ORIGINAL_NAME}, is_active=1")

# 3. Verify
cur.execute("SELECT id, name, is_active FROM trading_systems WHERE id = ?", [TS_ID])
row = cur.fetchone()
if row:
    print(f"\nVerified: ID={row[0]}, Name={row[1]}, Active={row[2]}")

# 4. Update algofund_profiles to point back to restored system
print("\n=== RECONNECTING CLIENTS ===")
tenant_ids = [1288, 41003, 43430]
for tid in tenant_ids:
    cur.execute(
        """
        UPDATE algofund_profiles 
        SET published_system_name = ?, 
            actual_enabled = 0,
            requested_enabled = 0,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?
        """,
        [ORIGINAL_NAME, tid]
    )
    con.commit()
    print(f"Reconnected tenant {tid} to {ORIGINAL_NAME}")

print("\n=== DONE ===")
con.close()

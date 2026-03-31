#!/usr/bin/env python3
import sqlite3

db_path = '/opt/battletoads-double-dragon/backend/database.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

cursor.execute("""
    UPDATE strategies 
    SET last_error = NULL, last_action = 'cleared_retry_v3'
    WHERE id IN (80127, 80126, 80111, 80110, 80100, 80090)
""")
conn.commit()
print(f"Cleared {cursor.rowcount} strategies for retry")

# Verify
cursor.execute("""
    SELECT id, last_error, last_action 
    FROM strategies 
    WHERE id IN (80127, 80126, 80111, 80110, 80100, 80090)
    ORDER BY id
""")
for r in cursor.fetchall():
    print(f"ID {r[0]:6} | error={str(r[1]):20} | action={r[2]}")

conn.close()

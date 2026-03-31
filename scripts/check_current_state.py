#!/usr/bin/env python3
import sqlite3

db_path = '/opt/battletoads-double-dragon/backend/database.db'
conn = sqlite3.connect(db_path)
cursor = conn.cursor()

cursor.execute("""
    SELECT id, last_error, last_action 
    FROM strategies 
    WHERE id IN (80127, 80126, 80111, 80110, 80100, 80090)
    ORDER BY id
""")

print("ТЕКУЩЕЕ СОСТОЯНИЕ СТРАТЕГИЙ:")
print("=" * 120)

for r in cursor.fetchall():
    id_s, err, action = r
    print(f"ID {id_s:6} | Action: {action:20} | Error: {str(err)[:90]}")

conn.close()

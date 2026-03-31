#!/usr/bin/env python3
"""Clear stale low-lot errors from DB after leverage fix deploy."""
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
db = sqlite3.connect(DB)
cur = db.cursor()

cur.execute("SELECT COUNT(*) FROM strategies WHERE last_error LIKE '%Order size too small for balanced pair execution%'")
count = cur.fetchone()[0]
print(f"Strategies with low-lot error: {count}")

cur.execute("SELECT id, name, base_symbol, quote_symbol, last_error FROM strategies WHERE last_error LIKE '%Order size too small for balanced pair execution%'")
rows = cur.fetchall()
for r in rows:
    print(f"  #{r[0]} {r[1]} | {r[2]}/{r[3]}")

cur.execute("UPDATE strategies SET last_error = '' WHERE last_error LIKE '%Order size too small for balanced pair execution%'")
db.commit()
print(f"\nCleared {cur.rowcount} strategies.")
db.close()
print("Done.")

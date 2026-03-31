#!/usr/bin/env python3
"""Resolve stale low_lot_error events and clear last_error after leverage fix deploy."""
import sqlite3
import time

DB = '/opt/battletoads-double-dragon/backend/database.db'
db = sqlite3.connect(DB)
db.row_factory = sqlite3.Row

now_ms = int(time.time() * 1000)
hours_back = 72 * 3600 * 1000
since_ms = now_ms - hours_back

# Check unresolved runtime events
rows = db.execute(
    """SELECT id, strategy_id, api_key_name, message
       FROM strategy_runtime_events
       WHERE event_type = 'low_lot_error'
         AND resolved_at = 0
         AND created_at >= ?""",
    [since_ms]
).fetchall()

print(f"Unresolved low_lot_error events: {len(rows)}")
for r in rows:
    print(f"  event #{r['id']} | strategy #{r['strategy_id']} | {r['api_key_name']} | {str(r['message'])[:60]}")

# Resolve them all
cur = db.execute(
    """UPDATE strategy_runtime_events
       SET resolved_at = ?
       WHERE event_type = 'low_lot_error'
         AND resolved_at = 0
         AND created_at >= ?""",
    [now_ms, since_ms]
)
db.commit()
print(f"\nResolved {cur.rowcount} events.")

# Also clear last_error from strategies
cur2 = db.execute(
    "UPDATE strategies SET last_error = '' WHERE last_error LIKE '%Order size too small%'"
)
db.commit()
print(f"Cleared last_error from {cur2.rowcount} strategies.")

db.close()
print("Done.")

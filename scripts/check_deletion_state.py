#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== CHECKING AFTER DELETION ===')
print()

print('ARCHIVED TS records:')
c.execute("SELECT id, name FROM trading_systems WHERE name LIKE '%ARCHIVED%' ORDER BY id DESC LIMIT 5")
archived = c.fetchall()
if archived:
    for r in archived:
        print(f'  ID: {r[0]}, Name: {r[1][:70]}...')
else:
    print('  (none)')

print()
print('ACTIVE high-trade TS:')
c.execute("SELECT id, name FROM trading_systems WHERE name LIKE '%high-trade%' AND name NOT LIKE '%ARCHIVED%'")
active = c.fetchall()
if active:
    for r in active:
        print(f'  ID: {r[0]}, Name: {r[1]}')
else:
    print('  (none)')

print()
print('ALL TS to find high-trade:')
c.execute("SELECT id, name, is_active FROM trading_systems WHERE id IN (25, 26, 27, 28, 29, 30)")
all_ts = c.fetchall()
for r in all_ts:
    print(f'  ID: {r[0]}, Active: {r[2]}, Name: {r[1][:50]}...')

db.close()

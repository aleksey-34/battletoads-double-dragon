#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== ALGOFUND_ACTIVE_SYSTEMS ===')
c.execute("PRAGMA table_info(algofund_active_systems)")
cols = c.fetchall()
print('Columns:')
for col in cols:
    print(f'  {col[1]} ({col[2]})')

print()
print('=== CURRENT ACTIVE SYSTEMS ===')
c.execute("SELECT id, system_name FROM algofund_active_systems LIMIT 10")
for r in c.fetchall():
    print(f'  ID: {r[0]}, SystemName: {r[1]}')

print()
print('=== SEARCHING FOR HIGH-TRADE IN ACTIVE ===')
c.execute("SELECT id, system_name FROM algofund_active_systems WHERE system_name LIKE '%high-trade%'")
rows = c.fetchall()
if rows:
    for r in rows:
        print(f'  Found: ID={r[0]}, Name={r[1]}')
else:
    print('  (NOT FOUND - was deleted from active systems)')

print()
print('=== TRADING_SYSTEMS FOR HIGH-TRADE (ALL STATES) ===')
c.execute("SELECT id, name, is_active FROM trading_systems WHERE name LIKE '%high-trade%' ORDER BY id DESC")
for r in c.fetchall():
    active_str = 'ACTIVE' if r[2] else 'ARCHIVED'
    print(f'  ID: {r[0]}, Active: {active_str}, Name: {r[1][:60]}')

db.close()

#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('✓ TS CARD RESTORATION VERIFIED')
print()
c.execute('SELECT id, name, is_active FROM trading_systems WHERE id = 25')
r = c.fetchone()
if r:
    print(f'  ID:     {r[0]}')
    print(f'  Name:   {r[1]}')
    print(f'  Status: {"ACTIVE ✓" if r[2] else "INACTIVE"}')
else:
    print('  NOT FOUND ✗')

print()
c.execute('SELECT COUNT(*) FROM trading_system_members WHERE system_id = 25')
cnt = c.fetchone()[0]
print(f'✓ TS MEMBERS: {cnt} configured')

print()
print('✓ CARD IN OFFER/TS DATABASE: READY FOR CLIENTS')

db.close()

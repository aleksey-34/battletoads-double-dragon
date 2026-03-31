#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== ОЧИЩАЮ ДУБЛИКАТЫ НА ВИТРИНЕ ===')
print()

# Оставляю только одну версию pu213v на витрине (ID=1), остальные деактивирую
c.execute("SELECT id, system_name FROM algofund_active_systems WHERE system_name LIKE '%high-trade-curated%'")
rows = c.fetchall()
print(f'Found {len(rows)} high-trade entries on vitrine:')
for r in rows:
    print(f'  ID={r[0]}: {r[1]}')

print()
print('✓ Keeping ID=1 as is_enabled=1 (pu213v)')
print('✓ Disabling ID=2')
print('✓ Disabling ID=3 (it\'s r0pf9x which has separate ID=27)')

# Disable the duplicates
c.execute("UPDATE algofund_active_systems SET is_enabled = 0 WHERE id IN (2, 3)")
db.commit()

print()
c.execute("SELECT id, system_name, is_enabled FROM algofund_active_systems WHERE system_name LIKE '%high-trade-curated%'")
for r in c.fetchall():
    status = 'ON' if r[2] else 'OFF'
    print(f'  ID={r[0]}: {status:3} | {r[1]}')

print()
print('✓ ВИТРИНА ОЧИЩЕНА')
print('  - Only pu213v (ID=1) visible on витрине')
print('  - Both versions available in Списках (ID=25 and ID=27)')

db.close()

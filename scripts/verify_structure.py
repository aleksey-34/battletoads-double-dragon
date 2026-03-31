#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== ВИТРИНА ТС АЛГОФОНДА (Витрина флаг) ===')
print()
c.execute("""SELECT a.id, a.system_name, a.is_enabled, t.is_active 
             FROM algofund_active_systems a
             LEFT JOIN trading_systems t ON t.name = a.system_name
             ORDER BY a.id""")
for r in c.fetchall():
    vitrine_status = 'ON' if r[2] else 'OFF'
    ts_status = 'ACTIVE' if r[3] else 'ARCHIVED'
    print(f'  {r[0]}. {r[1][:45]}')
    print(f'     Витрина: {vitrine_status}, Списки: {ts_status}')

print()
print('=== СПИСКИ ДЛЯ РАССМОТРЕНИЯ (Offer/TS) ===')
c.execute("SELECT id, name, is_active FROM trading_systems WHERE name LIKE '%ALGOFUND%' AND name NOT LIKE '%ARCHIVED%' ORDER BY id DESC LIMIT 5")
rows = c.fetchall()
if rows:
    for r in rows:
        status = 'ACTIVE' if r[2] else 'INACTIVE'
        print(f'  ID={r[0]}: {status:8} | {r[1]}')
else:
    print('  (нет активных ALGOFUND систем)')

print()
print('=== АРХИВИРОВАННЫЕ (должны быть пусто) ===')
c.execute("SELECT id, name FROM trading_systems WHERE name LIKE '%ARCHIVED%'")
archived = c.fetchall()
if archived:
    for r in archived:
        print(f'  ID={r[0]}: {r[1][:50]}...')
else:
    print('  (none)')

db.close()

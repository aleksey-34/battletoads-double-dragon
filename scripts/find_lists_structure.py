#!/usr/bin/env python3
import sqlite3
import json

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
db.row_factory = sqlite3.Row
c = db.cursor()

print('=== ALGOFUND_ACTIVE_SYSTEMS (Витрина флаг?) ===')
c.execute("PRAGMA table_info(algofund_active_systems)")
cols = [r[1] for r in c.fetchall()]
print(f'Columns: {cols}')

print()
print('=== ТЕКУЩИЕ TS В ВИТРИНЕ ===')
c.execute("SELECT id, system_name, is_enabled FROM algofund_active_systems")
for r in c.fetchall():
    print(f'  ID={r[0]}, Name={r[1]}, Enabled={r[2]}')

print()
print('=== ПОИСК ТАБЛИЦ С LISTS/CATALOGS/CANDIDATES ===')
c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = [r[0] for r in c.fetchall()]
candidate_tables = [t for t in tables if any(x in t.lower() for x in ['list', 'catalog', 'candidate', 'draft', 'offer'])]
print(f'Possible tables: {candidate_tables}')

print()
print('=== TRADING_SYSTEMS (основное хранилище) ===')
c.execute("PRAGMA table_info(trading_systems)")
ts_cols = [r[1] for r in c.fetchall()]
print(f'Columns: {ts_cols}')

print()
print('=== ПОИСК HIGH-TRADE В TS ===')
c.execute("SELECT id, name, is_active FROM trading_systems WHERE name LIKE '%high-trade%'")
for r in c.fetchall():
    status = 'ACTIVE' if r[2] else 'ARCHIVED'
    print(f'  ID={r[0]}, Status={status}, Name={r[1][:60]}')

db.close()

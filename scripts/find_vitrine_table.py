#!/usr/bin/env python3
import sqlite3

db = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
c = db.cursor()

print('=== DATABASE TABLES ===')
c.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
tables = [r[0] for r in c.fetchall()]
for t in tables:
    print(f'  {t}')

print()
print('=== ALGOFUND VITRINE/STOREFRONT TABLES ===')
vitrine_tables = [t for t in tables if 'vitrine' in t.lower() or 'storefront' in t.lower() or 'catalog' in t.lower() or 'publish' in t.lower()]
if vitrine_tables:
    for t in vitrine_tables:
        c.execute(f"SELECT COUNT(*) FROM {t}")
        cnt = c.fetchone()[0]
        print(f'  {t}: {cnt} records')
        
        c.execute(f"PRAGMA table_info({t})")
        cols = [r[1] for r in c.fetchall()]
        print(f'    Columns: {cols[:5]}...')
else:
    print('  (none found)')

print()
print('=== ALGOFUND PROFILES TABLE ===')
c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%algofund%' ORDER BY name")
algofund_tables = [r[0] for r in c.fetchall()]
for t in algofund_tables:
    print(f'  {t}')

db.close()

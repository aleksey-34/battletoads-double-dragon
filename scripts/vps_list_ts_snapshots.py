#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
KEY = 'offer.store.ts_backtest_snapshots'

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()
row = cur.execute('SELECT value FROM app_runtime_flags WHERE key = ?', (KEY,)).fetchone()
data = json.loads((row['value'] if row else '{}') or '{}')
rows = []
for key, snap in sorted(data.items()):
    if not isinstance(snap, dict):
        continue
    rows.append({
        'key': key,
        'systemName': snap.get('systemName'),
        'ret': snap.get('ret'),
        'dd': snap.get('dd'),
        'pf': snap.get('pf'),
        'trades': snap.get('trades'),
        'memberSymbolCounts': snap.get('memberSymbolCounts'),
    })
print(json.dumps(rows, ensure_ascii=False, indent=2))
con.close()

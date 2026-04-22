#!/usr/bin/env python3
import json
import sqlite3

con=sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
cur=con.cursor()
tables=[r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
trade_tables=[t for t in tables if 'trade' in t.lower() or 'position' in t.lower() or 'order' in t.lower()]
out={}
for t in trade_tables:
    cols=[r[1] for r in cur.execute(f'PRAGMA table_info({t})').fetchall()]
    cnt=cur.execute(f'SELECT COUNT(*) FROM {t}').fetchone()[0]
    out[t]={'count':cnt,'cols':cols}
print(json.dumps(out,ensure_ascii=False,indent=2))
con.close()

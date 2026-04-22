#!/usr/bin/env python3
import json
import sqlite3

con = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
con.row_factory = sqlite3.Row
cur = con.cursor()

cols = [dict(name=r[1], type=r[2]) for r in cur.execute('PRAGMA table_info(live_trade_events)').fetchall()]
rows = [dict(r) for r in cur.execute('SELECT * FROM live_trade_events LIMIT 5').fetchall()]

print(json.dumps({'columns': cols, 'sample': rows}, ensure_ascii=False, indent=2))
con.close()

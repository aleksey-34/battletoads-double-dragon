#!/usr/bin/env python3
import json
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
con=sqlite3.connect(DB)
con.row_factory=sqlite3.Row
cur=con.cursor()

api_ids=[4,6,17]
for aid in api_ids:
    sids=[r['id'] for r in cur.execute('SELECT id FROM strategies WHERE api_key_id=? AND COALESCE(is_runtime,1)=1 AND COALESCE(is_archived,0)=0',(aid,)).fetchall()]
    if not sids:
        print('api',aid,'no sids')
        continue
    ph=','.join('?' for _ in sids)
    rows=[dict(r) for r in cur.execute(f"SELECT * FROM live_trade_events WHERE strategy_id IN ({ph}) AND LOWER(COALESCE(trade_type,'')) IN ('exit','close') ORDER BY created_at DESC LIMIT 5",tuple(sids)).fetchall()]
    print('api',aid,'exit_rows',len(rows))
    print(json.dumps(rows,ensure_ascii=False,indent=2))

con.close()

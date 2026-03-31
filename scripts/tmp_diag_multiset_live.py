#!/usr/bin/env python3
import json
import sqlite3
import time

DB = '/opt/battletoads-double-dragon/backend/database.db'
SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'

conn = sqlite3.connect(DB)
cur = conn.cursor()
cur.execute('select id from trading_systems where name=? limit 1', (SYSTEM,))
r = cur.fetchone()
if not r:
    print(json.dumps({'error': 'system_not_found', 'system': SYSTEM}))
    raise SystemExit(0)

sid = int(r[0])
cur.execute('select strategy_id from trading_system_members where system_id=? and coalesce(is_enabled,1)=1', (sid,))
ids = [int(x[0]) for x in cur.fetchall()]

out = {'systemId': sid, 'members': len(ids), 'windows': {}}
if not ids:
    print(json.dumps(out, ensure_ascii=False))
    raise SystemExit(0)

ph = ','.join(['?'] * len(ids))
for label, days in [('1d', 1), ('7d', 7), ('30d', 30)]:
    q = f"""
    select
      count(*),
      sum(case when lower(coalesce(trade_type,''))='entry' then 1 else 0 end),
      sum(case when lower(coalesce(trade_type,''))='exit' then 1 else 0 end),
      max(actual_time)
    from live_trade_events
    where strategy_id in ({ph})
      and coalesce(actual_time,0) >= ?
    """
    cur.execute(q, (*ids, int((time.time() - 86400 * days) * 1000)))
    c, e, x, m = cur.fetchone()
    out['windows'][label] = {
        'events': int(c or 0),
        'entries': int(e or 0),
        'exits': int(x or 0),
        'latestActualTimeMs': m,
    }

print(json.dumps(out, ensure_ascii=False))

#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = [
    dict(r)
    for r in cur.execute(
        """
        SELECT ts.id, ts.name, ak.name AS api_key_name, ts.is_active, ts.max_open_positions,
               SUM(CASE WHEN COALESCE(m.is_enabled,1)=1 THEN 1 ELSE 0 END) AS members_enabled
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        LEFT JOIN trading_system_members m ON m.system_id = ts.id
        WHERE ts.name LIKE 'ALGOFUND_MASTER::BTDD_D1::%'
        GROUP BY ts.id
        ORDER BY ts.name
        """
    ).fetchall()
]

print(json.dumps(rows, ensure_ascii=False, indent=2))
con.close()

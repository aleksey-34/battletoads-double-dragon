#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

systems = cur.execute(
    """
    SELECT ts.id, ts.name, ak.name AS api_key_name
    FROM trading_systems ts
    JOIN api_keys ak ON ak.id = ts.api_key_id
    WHERE ts.name LIKE 'ALGOFUND_MASTER::BTDD_D1::%'
    ORDER BY ts.id DESC
    """
).fetchall()

out = []
for s in systems:
    members = [
        dict(r)
        for r in cur.execute(
            """
            SELECT m.strategy_id, m.is_enabled, st.base_symbol
            FROM trading_system_members m
            LEFT JOIN strategies st ON st.id = m.strategy_id
            WHERE m.system_id = ? AND COALESCE(m.is_enabled,1)=1
            """,
            (int(s["id"]),),
        ).fetchall()
    ]
    symbols = sorted(list({(x.get("base_symbol") or "").upper() for x in members if (x.get("base_symbol") or "").strip()}))
    out.append({
        "id": int(s["id"]),
        "name": s["name"],
        "members": len(members),
        "symbols": symbols,
    })

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

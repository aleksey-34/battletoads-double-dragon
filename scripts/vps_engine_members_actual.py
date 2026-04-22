#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TARGETS = ["ALGOFUND::ruslan", "ALGOFUND::ali", "ALGOFUND::ivan-weex"]

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

out = []
for name in TARGETS:
    row = cur.execute(
        """
        SELECT ts.id AS system_id, ts.name, ts.max_open_positions, ak.name AS api_key_name
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        WHERE ts.name = ?
        LIMIT 1
        """,
        (name,),
    ).fetchone()
    if not row:
        out.append({"systemName": name, "error": "system_not_found"})
        continue

    members = [
        dict(x)
        for x in cur.execute(
            """
            SELECT s.id AS strategy_id, s.name AS strategy_name, s.base_symbol, m.is_enabled
            FROM trading_system_members m
            JOIN strategies s ON s.id = m.strategy_id
            WHERE m.system_id = ?
            ORDER BY m.id
            """,
            (int(row["system_id"]),),
        ).fetchall()
    ]

    enabled = [x for x in members if int(x.get("is_enabled") or 0) == 1]
    out.append(
        {
            "systemId": int(row["system_id"]),
            "systemName": row["name"],
            "apiKeyName": row["api_key_name"],
            "maxOpenPositions": int(row["max_open_positions"] or 0),
            "membersEnabledCount": len(enabled),
            "memberSymbols": sorted(list({(x.get("base_symbol") or "").upper() for x in enabled if (x.get("base_symbol") or "").strip()})),
            "memberStrategyIds": [int(x["strategy_id"]) for x in enabled],
        }
    )

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

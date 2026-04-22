#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TENANTS = [41170, 41232, 69181]

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

rows = cur.execute(
    """
    SELECT t.id AS tenant_id, t.slug, ap.published_system_name
    FROM tenants t
    JOIN algofund_profiles ap ON ap.tenant_id = t.id
    WHERE t.id IN (%s)
    ORDER BY t.id
    """ % ",".join("?" for _ in TENANTS),
    TENANTS,
).fetchall()

out = []
for row in rows:
    source_name = row["published_system_name"]
    sys = cur.execute(
        "SELECT id, name, api_key_id FROM trading_systems WHERE name = ? LIMIT 1",
        (source_name,),
    ).fetchone()
    item = {
        "tenantId": row["tenant_id"],
        "slug": row["slug"],
        "publishedSystemName": source_name,
        "sourceExists": bool(sys),
        "sourceMembersCount": 0,
        "sourceMemberSymbols": [],
    }
    if sys:
        members = [
            dict(m)
            for m in cur.execute(
                """
                SELECT s.id AS strategy_id, s.base_symbol, s.name, m.is_enabled
                FROM trading_system_members m
                JOIN strategies s ON s.id = m.strategy_id
                WHERE m.system_id = ? AND COALESCE(m.is_enabled,1)=1
                ORDER BY m.id
                """,
                (int(sys["id"]),),
            ).fetchall()
        ]
        item["sourceMembersCount"] = len(members)
        item["sourceMemberSymbols"] = sorted(list({(x.get("base_symbol") or "").upper() for x in members if (x.get("base_symbol") or "").strip()}))
        item["sourceMemberStrategyIds"] = [int(x["strategy_id"]) for x in members]
    out.append(item)

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TARGET_MASTER = "ALGOFUND_MASTER::BTDD_D1::mega-portfolio"


def rows_to_dicts(rows):
    return [dict(r) for r in rows]


con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

profiles = rows_to_dicts(
    cur.execute(
        """
        SELECT t.id AS tenant_id,
               t.slug,
               t.display_name,
               ap.published_system_name,
               ap.execution_api_key_name,
               ap.requested_enabled,
               ap.actual_enabled
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE ap.published_system_name = ?
        ORDER BY t.id
        """,
        (TARGET_MASTER,),
    ).fetchall()
)

out = {
    "targetMaster": TARGET_MASTER,
    "profiles": profiles,
    "masterSystem": None,
    "engines": [],
}

master = cur.execute(
    "SELECT id, name, api_key_id, max_open_positions, is_active FROM trading_systems WHERE name = ? LIMIT 1",
    (TARGET_MASTER,),
).fetchone()
if master:
    mid = int(master["id"])
    members = rows_to_dicts(
        cur.execute(
            """
            SELECT tsm.strategy_id, tsm.weight, tsm.is_enabled, s.name AS strategy_name, s.base_symbol, s.quote_symbol
            FROM trading_system_members tsm
            JOIN strategies s ON s.id = tsm.strategy_id
            WHERE tsm.system_id = ?
            ORDER BY tsm.id
            """,
            (mid,),
        ).fetchall()
    )
    out["masterSystem"] = dict(master)
    out["masterSystem"]["membersCount"] = len([m for m in members if int(m.get("is_enabled") or 0) == 1])
    out["masterSystem"]["members"] = members[:30]

for p in profiles:
    engine_name = f"ALGOFUND::{p['slug']}"
    ts = cur.execute(
        "SELECT id, name, api_key_id, max_open_positions, is_active FROM trading_systems WHERE name = ? LIMIT 1",
        (engine_name,),
    ).fetchone()
    item = {
        "tenantId": p["tenant_id"],
        "slug": p["slug"],
        "engineName": engine_name,
        "engine": dict(ts) if ts else None,
        "membersCount": 0,
        "members": [],
    }
    if ts:
        sid = int(ts["id"])
        members = rows_to_dicts(
            cur.execute(
                """
                SELECT tsm.strategy_id, tsm.weight, tsm.is_enabled, s.name AS strategy_name, s.base_symbol, s.quote_symbol
                FROM trading_system_members tsm
                JOIN strategies s ON s.id = tsm.strategy_id
                WHERE tsm.system_id = ?
                ORDER BY tsm.id
                """,
                (sid,),
            ).fetchall()
        )
        item["membersCount"] = len([m for m in members if int(m.get("is_enabled") or 0) == 1])
        item["members"] = members[:30]
    out["engines"].append(item)

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

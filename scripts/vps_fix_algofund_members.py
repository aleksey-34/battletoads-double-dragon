#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TARGETS = ["ALGOFUND::ruslan", "ALGOFUND::ali", "ALGOFUND::ivan-weex"]
TARGET_MAX_OP = 4

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

tsm_cols = [r[1] for r in cur.execute("PRAGMA table_info(trading_system_members)").fetchall()]

summary = {
    "ts": datetime.utcnow().isoformat() + "Z",
    "targets": [],
}

# Snapshot before
for name in TARGETS:
    ts = cur.execute(
        "SELECT id,name,api_key_id,max_open_positions,is_active FROM trading_systems WHERE name=? LIMIT 1",
        (name,),
    ).fetchone()
    if not ts:
        summary["targets"].append({"systemName": name, "error": "system_not_found"})
        continue

    sid = int(ts["id"])
    members_before = [
        dict(r)
        for r in cur.execute(
            """
            SELECT m.strategy_id, m.weight, m.is_enabled, s.name AS strategy_name, s.base_symbol
            FROM trading_system_members m
            LEFT JOIN strategies s ON s.id = m.strategy_id
            WHERE m.system_id = ?
            ORDER BY m.id
            """,
            (sid,),
        ).fetchall()
    ]

    # Candidate active strategies on same API key, dedup by base symbol by recency
    active = [
        dict(r)
        for r in cur.execute(
            """
            SELECT id, name, base_symbol, quote_symbol, updated_at
            FROM strategies
            WHERE api_key_id = ?
              AND COALESCE(is_runtime, 1) = 1
              AND COALESCE(is_archived, 0) = 0
              AND COALESCE(is_active, 0) = 1
            ORDER BY updated_at DESC, id DESC
            """,
            (int(ts["api_key_id"]),),
        ).fetchall()
    ]

    selected = []
    seen = set()
    for s in active:
        sym = (s.get("base_symbol") or "").strip().upper()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        selected.append(s)

    # Rebuild members
    cur.execute("DELETE FROM trading_system_members WHERE system_id = ?", (sid,))

    for idx, s in enumerate(selected):
        role = "core" if idx < 3 else "satellite"
        values = {
            "system_id": sid,
            "strategy_id": int(s["id"]),
            "weight": 1.0,
            "member_role": role,
            "is_enabled": 1,
            "notes": "algofund runtime repair",
        }
        if "created_at" in tsm_cols:
            values["created_at"] = "CURRENT_TIMESTAMP"
        if "updated_at" in tsm_cols:
            values["updated_at"] = "CURRENT_TIMESTAMP"

        cols = []
        placeholders = []
        params = []
        for k, v in values.items():
            if k not in tsm_cols:
                continue
            cols.append(k)
            if isinstance(v, str) and v == "CURRENT_TIMESTAMP":
                placeholders.append("CURRENT_TIMESTAMP")
            else:
                placeholders.append("?")
                params.append(v)

        cur.execute(
            f"INSERT INTO trading_system_members ({', '.join(cols)}) VALUES ({', '.join(placeholders)})",
            tuple(params),
        )

    new_max_op = min(TARGET_MAX_OP, max(1, len(selected)))
    cur.execute(
        """
        UPDATE trading_systems
        SET max_open_positions = ?, is_active = 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (new_max_op, sid),
    )

    members_after = [
        dict(r)
        for r in cur.execute(
            """
            SELECT m.strategy_id, m.weight, m.is_enabled, s.name AS strategy_name, s.base_symbol
            FROM trading_system_members m
            LEFT JOIN strategies s ON s.id = m.strategy_id
            WHERE m.system_id = ?
            ORDER BY m.id
            """,
            (sid,),
        ).fetchall()
    ]

    summary["targets"].append(
        {
            "systemName": name,
            "systemId": sid,
            "apiKeyId": int(ts["api_key_id"]),
            "maxOpenPositionsBefore": int(ts["max_open_positions"] or 0),
            "maxOpenPositionsAfter": new_max_op,
            "membersBefore": len(members_before),
            "membersAfter": len(members_after),
            "selectedSymbols": [x.get("base_symbol") for x in selected],
            "selectedStrategyIds": [int(x["id"]) for x in selected],
        }
    )

con.commit()
print(json.dumps(summary, ensure_ascii=False, indent=2))
con.close()

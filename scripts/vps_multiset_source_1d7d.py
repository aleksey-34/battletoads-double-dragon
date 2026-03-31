#!/usr/bin/env python3
import json
import sqlite3
import time

DB = "/opt/battletoads-double-dragon/backend/database.db"
SYSTEM_NAME = "ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh"


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    row = conn.execute(
        """
        SELECT ts.id AS system_id, ak.name AS api_key_name
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        WHERE ts.name = ?
        LIMIT 1
        """,
        (SYSTEM_NAME,),
    ).fetchone()
    if not row:
        print(json.dumps({"error": "system not found", "systemName": SYSTEM_NAME}, ensure_ascii=False, indent=2))
        return

    system_id = int(row["system_id"])
    strategy_rows = conn.execute(
        "SELECT strategy_id FROM trading_system_members WHERE system_id = ?",
        (system_id,),
    ).fetchall()
    strategy_ids = [int(r["strategy_id"]) for r in strategy_rows]

    now_ms = int(time.time() * 1000)
    t1 = now_ms - 24 * 3600 * 1000
    t7 = now_ms - 7 * 24 * 3600 * 1000

    result = {
        "systemName": SYSTEM_NAME,
        "apiKey": row["api_key_name"],
        "membersCount": len(strategy_ids),
        "windows": {},
    }

    if not strategy_ids:
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    placeholders = ",".join("?" for _ in strategy_ids)
    for label, since in [("1d", t1), ("7d", t7)]:
        rows = conn.execute(
            f"""
            SELECT lower(COALESCE(trade_type,'')) AS trade_type, COUNT(*) AS cnt
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders}) AND COALESCE(actual_time,0) >= ?
            GROUP BY lower(COALESCE(trade_type,''))
            """,
            tuple(strategy_ids) + (since,),
        ).fetchall()
        stats = {"events": 0, "entries": 0, "exits": 0}
        for r in rows:
            t = str(r["trade_type"] or "")
            cnt = int(r["cnt"] or 0)
            stats["events"] += cnt
            if t == "entry":
                stats["entries"] += cnt
            if t == "exit":
                stats["exits"] += cnt
        result["windows"][label] = stats

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

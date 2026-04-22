#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
KEY = "offer.store.ts_backtest_snapshots"
TARGETS = [
    "ALGOFUND_MASTER::BTDD_D1::high-freq",
    "ALGOFUND_MASTER::BTDD_D1::volume-pulse-v1",
]


def main() -> None:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key = ?", (KEY,)).fetchone()
    data = json.loads((row["value"] if row else "{}") or "{}")

    out = []
    for target in TARGETS:
        snap = data.get(target) or {}
        out.append(
            {
                "key": target,
                "systemName": snap.get("systemName"),
                "ret": snap.get("ret"),
                "dd": snap.get("dd"),
                "pf": snap.get("pf"),
                "winRate": snap.get("winRate"),
                "trades": snap.get("trades"),
                "tradesPerDay": snap.get("tradesPerDay"),
                "periodDays": snap.get("periodDays"),
                "memberSymbolCounts": snap.get("memberSymbolCounts"),
                "offerCount": len(snap.get("offerIds") or []),
            }
        )

    print(json.dumps(out, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()

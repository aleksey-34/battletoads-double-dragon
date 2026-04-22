#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
KEY = "offer.store.ts_backtest_snapshots"
TARGETS = [
    "ALGOFUND_MASTER::BTDD_D1::high-freq",
    "ALGOFUND_MASTER::BTDD_D1::volume-pulse-v1",
]


def is_linear(points: list) -> bool:
    if len(points) < 4:
        return True
    diffs = []
    for i in range(1, len(points)):
        try:
            diffs.append(float(points[i]) - float(points[i - 1]))
        except Exception:
            return False
    first = diffs[0]
    return all(abs(d - first) < 1e-8 for d in diffs[1:])


def main() -> None:
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()
    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key = ?", (KEY,)).fetchone()
    data = json.loads((row["value"] if row else "{}") or "{}")
    out = []
    for target in TARGETS:
        s = data.get(target) or {}
        eq = s.get("equityPoints") if isinstance(s.get("equityPoints"), list) else []
        out.append(
            {
                "key": target,
                "winRate": s.get("winRate"),
                "equityCount": len(eq),
                "equityFirst": eq[0] if eq else None,
                "equityLast": eq[-1] if eq else None,
                "equityLinear": is_linear(eq) if eq else None,
                "equityPreview": eq[:8],
            }
        )
    print(json.dumps(out, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()

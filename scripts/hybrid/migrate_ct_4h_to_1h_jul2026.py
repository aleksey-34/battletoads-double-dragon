#!/usr/bin/env python3
"""
Bump CT_Fractal synth legs from 4h -> 1h on BTDD_D1 master (momentum stays 15m).
Dry-run by default; APPLY=1 to write.

  APPLY=1 BTDD_DB_PATH=/opt/.../database.db python3 scripts/hybrid/migrate_ct_4h_to_1h_jul2026.py
"""
from __future__ import annotations

import json
import os
import sqlite3

DB = os.environ.get("BTDD_DB_PATH", os.path.join(os.path.dirname(__file__), "..", "..", "backend", "database.db"))
API_KEY = os.environ.get("BTDD_API_KEY", "BTDD_D1")
APPLY = os.environ.get("APPLY", "").strip() in ("1", "true", "yes")


def main() -> None:
    conn = sqlite3.connect(DB)
    rows = conn.execute(
        """
        SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type
        FROM strategies s
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE a.name = ?
          AND s.strategy_type = 'CT_Fractal'
          AND COALESCE(s.interval, '') = '4h'
        ORDER BY s.id
        """,
        (API_KEY,),
    ).fetchall()

    out = {
        "apiKey": API_KEY,
        "apply": APPLY,
        "targets": [
            {
                "id": int(r[0]),
                "name": r[1],
                "market": f"{r[2]}/{r[3]}" if r[3] else r[2],
                "from": r[4],
                "to": "1h",
            }
            for r in rows
        ],
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))

    if APPLY and rows:
        conn.execute(
            """
            UPDATE strategies
            SET interval = '1h', updated_at = datetime('now')
            WHERE id IN ({})
            """.format(",".join("?" * len(rows))),
            [int(r[0]) for r in rows],
        )
        conn.commit()
        print(f"Updated {len(rows)} CT_Fractal legs 4h -> 1h on {API_KEY}")


if __name__ == "__main__":
    main()

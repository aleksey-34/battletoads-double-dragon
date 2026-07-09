#!/usr/bin/env python3
"""Revert CT_Fractal legs that were migrated 4h→1h back to 4h on BTDD_D1 master."""
from __future__ import annotations

import json
import os
import sqlite3

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
API_KEY = os.environ.get("BTDD_API_KEY", "BTDD_D1")
APPLY = os.environ.get("APPLY", "").strip() in ("1", "true", "yes")
# Only touch the B3 card members that are CT on 1h (the ones we migrated)
ONLY_B3 = os.environ.get("ONLY_B3", "1").strip() in ("1", "true", "yes")


def main() -> None:
    conn = sqlite3.connect(DB)
    if ONLY_B3:
        rows = conn.execute(
            """
            SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval
            FROM trading_system_members m
            JOIN trading_systems ts ON ts.id = m.system_id
            JOIN strategies s ON s.id = m.strategy_id
            WHERE ts.name LIKE '%synth-stable-union-v4-4-b3%'
              AND s.strategy_type = 'CT_Fractal'
              AND s.interval = '1h'
            ORDER BY s.id
            """
        ).fetchall()
    else:
        rows = conn.execute(
            """
            SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval
            FROM strategies s
            JOIN api_keys a ON a.id = s.api_key_id
            WHERE a.name = ?
              AND s.strategy_type = 'CT_Fractal'
              AND s.interval = '1h'
              AND s.name LIKE 'SYNTH4H_CTF_%'
            ORDER BY s.id
            """,
            (API_KEY,),
        ).fetchall()

    out = {
        "apply": APPLY,
        "onlyB3": ONLY_B3,
        "targets": [
            {
                "id": int(r[0]),
                "name": r[1],
                "market": f"{r[2]}/{r[3]}" if r[3] else r[2],
                "from": r[4],
                "to": "4h",
            }
            for r in rows
        ],
    }
    print(json.dumps(out, indent=2, ensure_ascii=False))
    if APPLY and rows:
        conn.execute(
            "UPDATE strategies SET interval='4h', updated_at=datetime('now') WHERE id IN ({})".format(
                ",".join("?" * len(rows))
            ),
            [int(r[0]) for r in rows],
        )
        conn.commit()
        print(f"Reverted {len(rows)} CT legs 1h -> 4h", flush=True)


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Retry materialize for all clients on balanced-shield-dca-v1-x4wc64."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
SHIELD = "%balanced-shield-dca-v1%"


def main() -> None:
    conn = sqlite3.connect(DB_PATH)
    rows = conn.execute(
        """
        SELECT t.id, t.slug
        FROM algofund_profiles ap
        JOIN tenants t ON t.id = ap.tenant_id
        WHERE ap.published_system_name LIKE ?
        ORDER BY t.slug
        """,
        (SHIELD,),
    ).fetchall()
    print(f"Rematerialize {len(rows)} shield clients")
    ok = 0
    for tenant_id, slug in rows:
        print(f"  [{ok+1}/{len(rows)}] {slug}...", end=" ", flush=True)
        for attempt in range(3):
            try:
                r = requests.post(
                    f"{API}/api/saas/algofund/{tenant_id}/retry-materialize",
                    headers=HEADERS,
                    json={},
                    timeout=900,
                )
                if r.status_code == 200:
                    print("200")
                    ok += 1
                    break
                print(f"{r.status_code}", end=" ")
            except Exception as exc:  # noqa: BLE001
                print(f"err:{exc}", end=" ")
            time.sleep(5)
        else:
            print("FAIL")
        time.sleep(2)
    print(f"DONE {ok}/{len(rows)}")


if __name__ == "__main__":
    main()

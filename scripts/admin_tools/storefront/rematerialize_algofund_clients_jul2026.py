#!/usr/bin/env python3
"""Rematerialize active algofund clients after master card patch."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026').strip()}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}


def main() -> None:
    conn = sqlite3.connect(DB)
    clients = conn.execute(
        """
        SELECT DISTINCT t.id, t.slug
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.actual_enabled, 0) = 1
          AND COALESCE(ap.requested_enabled, 0) = 1
          AND (
            ap.published_system_name LIKE '%synth-stable-union%'
            OR ap.published_system_name LIKE '%tv-momentum-cloud%'
            OR t.slug LIKE 'artursk%'
          )
        ORDER BY t.slug
        """,
    ).fetchall()
    print(f"clients={len(clients)}", flush=True)
    ok = fail = 0
    for tid, slug in clients:
        try:
            r = requests.post(
                f"{API}/api/saas/algofund/{tid}/retry-materialize",
                headers=HEADERS,
                json={},
                timeout=900,
            )
            r.raise_for_status()
            print(f"  ok {slug}", flush=True)
            ok += 1
        except Exception as exc:
            print(f"  fail {slug}: {exc}", flush=True)
            fail += 1
        time.sleep(0.5)
    print(f"done ok={ok} fail={fail}", flush=True)


if __name__ == "__main__":
    main()

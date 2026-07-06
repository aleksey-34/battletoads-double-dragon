#!/usr/bin/env python3
"""Rematerialize clients not yet in /tmp/remat_done.txt."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
DONE_FILE = os.environ.get("REMAT_DONE_FILE", "/tmp/remat_done.txt")
AUTH = f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026').strip()}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

ALREADY_DONE = {
    "ali",
    "artursk-1049539016",
    "artursk-1316522224",
    "artursk-1702322932",
    "artursk-1717746786",
    "artursk-1756891154",
    "artursk-4149120679",
    "artursk-5497016674",
    "artursk-6323499563",
    "artursk-6659194994",
    "artursk-6717415191",
}


def main() -> None:
    done = set(ALREADY_DONE)
    if os.path.isfile(DONE_FILE):
        done |= {line.strip() for line in open(DONE_FILE, encoding="utf-8") if line.strip()}

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

    pending = [(tid, slug) for tid, slug in clients if slug not in done]
    print(f"pending={len(pending)}", flush=True)
    ok = fail = 0
    for tid, slug in pending:
        try:
            r = requests.post(
                f"{API}/api/saas/algofund/{tid}/retry-materialize",
                headers=HEADERS,
                json={},
                timeout=900,
            )
            r.raise_for_status()
            print(f"  ok {slug}", flush=True)
            done.add(slug)
            ok += 1
        except Exception as exc:
            print(f"  fail {slug}: {exc}", flush=True)
            fail += 1
        time.sleep(0.5)

    with open(DONE_FILE, "w", encoding="utf-8") as fh:
        fh.write("\n".join(sorted(done)) + "\n")
    print(f"done ok={ok} fail={fail} total={len(done)}", flush=True)


if __name__ == "__main__":
    main()

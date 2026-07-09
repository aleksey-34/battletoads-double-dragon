#!/usr/bin/env python3
"""Rematerialize remaining B3 clients one-by-one with API health waits (avoid OOM)."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026').strip()}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
PAUSE = float(os.environ.get("REMAT_PAUSE_SEC", "8"))


def api_up() -> bool:
    try:
        r = requests.get(f"{API}/api/health", timeout=5)
        return r.status_code in (200, 401)
    except Exception:
        return False


def wait_api(timeout: float = 120) -> bool:
    t0 = time.time()
    while time.time() - t0 < timeout:
        if api_up():
            return True
        time.sleep(2)
    return False


def main() -> None:
    if not wait_api():
        raise SystemExit("API not up")
    conn = sqlite3.connect(DB)
    # clients still having any CT 4h legs OR not yet rematerialized after master 1h
    clients = conn.execute(
        """
        SELECT DISTINCT t.id, t.slug
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.actual_enabled, 0) = 1
          AND ap.published_system_name LIKE '%synth-stable-union-v4-4-b3%'
          AND EXISTS (
            SELECT 1
            FROM trading_systems ts
            JOIN trading_system_members m ON m.system_id = ts.id
            JOIN strategies s ON s.id = m.strategy_id
            WHERE ts.name = 'ALGOFUND::' || t.slug
              AND s.strategy_type = 'CT_Fractal'
              AND s.interval = '4h'
          )
        ORDER BY t.slug
        """
    ).fetchall()
    # also include failed ones from previous run even if no 4h (composition may be stale)
    if not clients:
        clients = conn.execute(
            """
            SELECT DISTINCT t.id, t.slug
            FROM tenants t
            JOIN algofund_profiles ap ON ap.tenant_id = t.id
            WHERE COALESCE(ap.actual_enabled, 0) = 1
              AND ap.published_system_name LIKE '%synth-stable-union-v4-4-b3%'
            ORDER BY t.slug
            """
        ).fetchall()
    print(f"targets={len(clients)}", flush=True)
    ok = fail = 0
    for tid, slug in clients:
        if not wait_api(90):
            print(f"skip {slug}: api down", flush=True)
            fail += 1
            continue
        try:
            r = requests.post(
                f"{API}/api/saas/algofund/{tid}/retry-materialize",
                headers=HEADERS,
                json={},
                timeout=900,
            )
            r.raise_for_status()
            print(f"ok {slug}", flush=True)
            ok += 1
        except Exception as exc:
            print(f"fail {slug}: {exc}", flush=True)
            fail += 1
            # give API time to recover if it crashed
            time.sleep(15)
            wait_api(120)
        time.sleep(PAUSE)
    after = conn.execute(
        """
        SELECT s.interval, COUNT(*)
        FROM strategies s
        JOIN trading_system_members m ON m.strategy_id = s.id
        JOIN trading_systems ts ON ts.id = m.system_id
        WHERE ts.name LIKE 'ALGOFUND::%'
          AND s.strategy_type = 'CT_Fractal'
        GROUP BY s.interval
        ORDER BY 1
        """
    ).fetchall()
    print("after_intervals", after, flush=True)
    print(f"done ok={ok} fail={fail}", flush=True)


if __name__ == "__main__":
    main()

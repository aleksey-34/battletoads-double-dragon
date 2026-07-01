#!/usr/bin/env python3
"""Disable bad/obsolete synth cards from vitrine; keep v3b + v2-synth pilot only."""
from __future__ import annotations

import argparse
import os
import sqlite3

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026")
if not AUTH.lower().startswith("bearer "):
    AUTH = f"Bearer {AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

REMOVE_SUBSTR = [
    "mega-synth-1d-jun2026",
    "mega-dca-super",
    "mega-union-v3v4",
    "union-mega-shield-jun2026-tfoaee",
    "synthetic-bomba",
    "synthetic-portfolio-v1",
    "synthetic-super-v1",
]

# Old union iterations (v1/v2/v3 with DCA/mono) — superseded by v3b
OLD_UNION_MARKERS = [
    "union-synth-heavy-jun2026-v3-",
    "union-synth-heavy-jun2026-v2-",
    "union-synth-heavy-jun2026-v1-",
]

KEEP_SUBSTR = [
    "union-synth-heavy-jun2026-v3b",
    "balanced-shield-dca-v2-synth",
    "balanced-shield-dca-v2-c66g2i",
]


def should_remove(name: str) -> bool:
    if any(k in name for k in KEEP_SUBSTR):
        return False
    if any(k in name for k in REMOVE_SUBSTR):
        return True
    # bare union-synth-heavy (no v3b) or old v1/v2/v3 published names
    if "union-synth-heavy-jun2026" in name:
        return True
    if any(k in name for k in OLD_UNION_MARKERS):
        return True
    return False


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()

    store = requests.get(f"{API}/api/saas/admin/offer-store", headers=HEADERS, timeout=120).json()
    published = list(store.get("algofundPublishedSystemNames") or [])

    remove = [name for name in published if should_remove(name)]

    print("Remove from vitrine:", remove)
    print("Keep:", [n for n in published if n not in remove])
    if not args.apply:
        print("Dry-run")
        return

    conn = sqlite3.connect(DB)
    for name in remove:
        conn.execute(
            "UPDATE algofund_active_systems SET is_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE system_name=?",
            (name,),
        )
    conn.commit()
    conn.close()

    next_pub = [n for n in published if n not in remove]
    snap_patch = {}
    for key in list((store.get("tsBacktestSnapshots") or {}).keys()):
        if key in ("mega-synth-1d-jun2026", "union-mega-shield-jun2026"):
            snap_patch[key] = None
        if key.startswith("union-synth-heavy-jun2026") and "v3b" not in key:
            snap_patch[key] = None

    requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
        "algofundPublishedSystemNames": next_pub,
        "tsBacktestSnapshotsPatch": snap_patch,
    }, timeout=120).raise_for_status()
    print("Done. published:", next_pub)


if __name__ == "__main__":
    main()

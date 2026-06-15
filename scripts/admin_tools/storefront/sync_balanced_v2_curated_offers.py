#!/usr/bin/env python3
"""Sync curated/published offer ids and snapshot dates for balanced-portfolio-v2."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2"
SNAP_KEYS = ("balanced-portfolio-v2", SYSTEM)


def load_json(cur: sqlite3.Cursor, key: str) -> object:
    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key=?", (key,)).fetchone()
    if not row:
        return None
    return json.loads(row[0])


def save_json(cur: sqlite3.Cursor, key: str, value: object) -> None:
    cur.execute(
        """
        INSERT INTO app_runtime_flags (key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=CURRENT_TIMESTAMP
        """,
        (key, json.dumps(value, ensure_ascii=False)),
    )


def compute_dates(snapshot: dict, *, force: bool = False) -> tuple[str, str]:
    settings = snapshot.get("backtestSettings") or {}
    if not force:
        date_from = str(settings.get("dateFrom") or "").strip()
        date_to = str(settings.get("dateTo") or "").strip()
        if len(date_from) == 10 and len(date_to) == 10:
            return date_from, date_to

    period_days = max(1, int(snapshot.get("periodDays") or 90))
    updated_at = str(snapshot.get("updatedAt") or "").strip()
    try:
        anchor = datetime.fromisoformat(updated_at.replace("Z", "+00:00"))
    except ValueError:
        anchor = datetime.now(timezone.utc)
    end = anchor.date()
    start = end - timedelta(days=period_days)
    return start.isoformat(), end.isoformat()


def main() -> None:
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()

    snaps = load_json(cur, "offer.store.ts_backtest_snapshots") or {}
    snapshot = None
    for key in SNAP_KEYS:
        candidate = snaps.get(key)
        if candidate and candidate.get("offerIds"):
            snapshot = candidate
            break
    if not snapshot:
        raise SystemExit("balanced-portfolio-v2 snapshot not found")

    offer_ids = list(dict.fromkeys(str(x).strip() for x in (snapshot.get("offerIds") or []) if str(x).strip()))
    print(f"snapshot offers: {len(offer_ids)}")

    curated = load_json(cur, "offer.store.curated_ids") or []
    published = load_json(cur, "offer.store.published_ids") or []
    print(f"curated before: {len(curated)}")
    print(f"published before: {len(published)}")

    save_json(cur, "offer.store.curated_ids", offer_ids)
    save_json(cur, "offer.store.published_ids", offer_ids)

    for key in SNAP_KEYS:
        if key not in snaps:
            continue
        patch = dict(snaps[key])
        key_dates = compute_dates(patch, force=True)
        key_settings = dict(patch.get("backtestSettings") or {})
        key_settings["dateFrom"] = key_dates[0]
        key_settings["dateTo"] = key_dates[1]
        if float(key_settings.get("initialBalance") or 0) < 1000:
            key_settings["initialBalance"] = 10000
        patch["backtestSettings"] = key_settings
        patch["offerIds"] = offer_ids
        snaps[key] = patch
        print(f"patched snapshot {key}: dates {key_dates[0]} -> {key_dates[1]}, offers {len(offer_ids)}")

    save_json(cur, "offer.store.ts_backtest_snapshots", snaps)
    conn.commit()
    conn.close()
    print("done")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Migrate algofund clients from shield-v2-synth → Synth Stable Union v4.2.

Recommended: close old exchange positions before switch (default).

  python3 scripts/admin_tools/storefront/migrate_clients_to_synth_v42.py --dry-run
  python3 scripts/admin_tools/storefront/migrate_clients_to_synth_v42.py --pilot ruslan
  python3 scripts/admin_tools/storefront/migrate_clients_to_synth_v42.py --all --yes
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))

SOURCE_SYSTEM = os.environ.get(
    "MIGRATE_FROM_SYSTEM",
    "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-synth-kka4ic",
)
TARGET_SYSTEM = os.environ.get(
    "MIGRATE_TO_SYSTEM",
    "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-2-jul2026-zbhya",
)
TARGET_SYSTEM_ID = int(os.environ.get("MIGRATE_TO_SYSTEM_ID", "186"))

CARD_METADATA = {
    "lotPercentOverride": 22,
    "maxOpenPositions": 15,
    "reinvestPercentOverride": 50,
    "portfolioCircuitBreaker": {
        "enabled": True,
        "peakWindowDays": 30,
        "ddTriggerPercent": 8,
        "lotMultiplier": 0.5,
        "pauseDays": 14,
    },
    "displayLabel": "Synth Stable Union v4.2 (+ TV 15m burst)",
    "category": "synth-stable-v42",
}


def api_post(path: str, payload: dict | None = None, timeout: int = 600) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def list_source_clients(cur: sqlite3.Cursor) -> list[tuple[int, str, str]]:
    return cur.execute(
        """
        SELECT t.id, t.slug, COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, '')
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE t.status = 'active'
          AND ap.published_system_name = ?
          AND COALESCE(ap.actual_enabled, 0) = 1
        ORDER BY t.slug
        """,
        (SOURCE_SYSTEM,),
    ).fetchall()


def ensure_master_card(cur: sqlite3.Cursor) -> None:
    row = cur.execute("SELECT id FROM trading_systems WHERE name=?", (TARGET_SYSTEM,)).fetchone()
    if not row:
        raise RuntimeError(f"Target TS missing: {TARGET_SYSTEM}")
    ts_id = int(row[0])
    card_code = f"CARD::{TARGET_SYSTEM.upper()}"
    cur.execute(
        """
        INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET
          name = excluded.name,
          description = excluded.description,
          source_system_id = excluded.source_system_id,
          is_active = 1,
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
        """,
        (
            card_code,
            CARD_METADATA["displayLabel"],
            "Synth Stable Union v4.2 — 20 legs + TV 15m burst + CB8",
            ts_id,
            json.dumps(CARD_METADATA),
        ),
    )
    card_id = cur.execute("SELECT id FROM master_cards WHERE code=?", (card_code,)).fetchone()[0]
    cur.execute("DELETE FROM master_card_members WHERE card_id=?", (card_id,))
    members = cur.execute(
        """
        SELECT strategy_id, weight, member_role, is_enabled, notes
        FROM trading_system_members
        WHERE system_id=? AND COALESCE(is_enabled,1)=1
        ORDER BY strategy_id
        """,
        (ts_id,),
    ).fetchall()
    for m in members:
        cur.execute(
            """
            INSERT INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (card_id, m[0], m[1], m[2], m[3], m[4] or "v4.2"),
        )
    print(f"master_card {card_code}: {len(members)} members")


def flatten_account(api_key: str, dry_run: bool) -> None:
    if not api_key or dry_run:
        print(f"  [dry-run] flatten {api_key}")
        return
    api_post(f"/api/orders/{api_key}/cancel-all", {}, timeout=120)
    api_post(f"/api/positions/{api_key}/close-all", {}, timeout=180)
    print(f"  ✓ flattened {api_key}")


def switch_client(tenant_id: int, slug: str, dry_run: bool) -> None:
    if dry_run:
        print(f"  [dry-run] switch {slug} → {TARGET_SYSTEM}")
        return
    payload = {
        "tenantIds": [tenant_id],
        "requestType": "switch_system",
        "note": f"Migrate {slug} to Synth Stable v4.2",
        "targetSystemId": TARGET_SYSTEM_ID,
        "targetSystemName": TARGET_SYSTEM,
        "directExecute": True,
    }
    result = api_post("/api/saas/admin/algofund-batch-actions", payload, timeout=900)
    failures = result.get("failures") or []
    if failures:
        raise RuntimeError(str(failures[0].get("error") or failures))
    api_post(f"/api/saas/algofund/{tenant_id}/retry-materialize", {}, timeout=900)
    print(f"  ✓ {slug} → v4.2 materialized")


def migrate_one(tenant_id: int, slug: str, api_key: str, close_positions: bool, dry_run: bool) -> None:
    print(f"→ {slug} ({api_key})")
    if close_positions:
        flatten_account(api_key, dry_run)
        if not dry_run:
            time.sleep(2)
    switch_client(tenant_id, slug, dry_run)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--pilot", metavar="SLUG")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--yes", action="store_true")
    parser.add_argument("--no-close", action="store_true", help="Skip cancel/close before switch (not recommended)")
    parser.add_argument("--skip-card", action="store_true")
    args = parser.parse_args()

    with conn() as db:
        cur = db.cursor()
        if not args.skip_card:
            ensure_master_card(cur)
            db.commit()
        clients = list_source_clients(cur)

    print(f"Source: {SOURCE_SYSTEM}")
    print(f"Target: {TARGET_SYSTEM} (id={TARGET_SYSTEM_ID})")
    print(f"Active clients on source: {len(clients)}")

    if args.dry_run:
        for tid, slug, key in clients:
            migrate_one(tid, slug, key, not args.no_close, dry_run=True)
        return

    if args.pilot:
        match = [(tid, slug, key) for tid, slug, key in clients if slug == args.pilot.strip()]
        if not match:
            raise SystemExit(f"Pilot slug not on source system: {args.pilot}")
        tid, slug, key = match[0]
        migrate_one(tid, slug, key, not args.no_close, dry_run=False)
        return

    if args.all:
        if not args.yes:
            raise SystemExit("Use --yes to confirm batch migration")
        ok, fail = 0, 0
        for tid, slug, key in clients:
            try:
                migrate_one(tid, slug, key, not args.no_close, dry_run=False)
                ok += 1
                time.sleep(3)
            except Exception as exc:
                fail += 1
                print(f"  ✗ {slug}: {exc}")
        print(f"Done: ok={ok} fail={fail}")
        return

    print("Usage: --dry-run | --pilot SLUG | --all --yes")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Setup shield master card + DCA on master TS, then migrate algofund clients from balanced-v2.

  python3 scripts/admin_tools/storefront/migrate_clients_to_shield.py --setup-only
  python3 scripts/admin_tools/storefront/migrate_clients_to_shield.py --pilot btdd-d1
  python3 scripts/admin_tools/storefront/migrate_clients_to_shield.py --all --yes
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

SHIELD_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v1-x4wc64"
V2_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2"
V2_CARD = "CARD::ALGOFUND_MASTER::BTDD_D1::BALANCED-PORTFOLIO-V2"
SHIELD_CARD = f"CARD::{SHIELD_SYSTEM.upper()}"

CARD_METADATA = {
    "maxOpenPositions": 10,
    "lotPercentOverride": 20,
    "reinvestPercentOverride": 100,
    "macroShield": True,
    "riskScore": 10,
    "tradeFrequencyScore": 8,
    "riskScaleMaxPercent": 500,
    "category": "balanced-shield",
    "displayLabel": "Balanced Shield + DCA",
}

DCA_APPLY_PAYLOAD = {
    "systemName": SHIELD_SYSTEM,
    "setKey": "balanced-shield-dca-v1-x4wc64",
    "markets": ["SUIUSDT", "TRXUSDT"],
    "macroShield": True,
    "dcaStepPercent": 12,
    "dcaMaxOrders": 30,
    "dcaTpPercent": 20,
    "dcaBaseAmountMode": "percent",
    "dcaBaseAmountPercent": 4,
    "dcaInterval": "15m",
    "dcaDetectionSource": "close",
    "dcaEntryFilter": "always",
    "riskScore": 10,
    "tradeFrequencyScore": 8,
    "reinvestPercent": 100,
    "lotPercentOverride": 20,
    "maxOpenPositions": 10,
    "riskScaleMaxPercent": 500,
    "initialBalance": 10000,
}


def api_post(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def conn() -> sqlite3.Connection:
    return sqlite3.connect(DB_PATH)


def setup_master_card(cur: sqlite3.Cursor) -> None:
    ts = cur.execute("SELECT id FROM trading_systems WHERE name=?", (SHIELD_SYSTEM,)).fetchone()
    if not ts:
        raise RuntimeError(f"Master TS not found: {SHIELD_SYSTEM}")
    ts_id = ts[0]

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
            SHIELD_CARD,
            "Balanced Shield + DCA",
            "balanced-v2 core + macro RSI shield + DCA satellite (client settings: lot 20%, reinvest 100%)",
            ts_id,
            json.dumps(CARD_METADATA),
        ),
    )
    shield_card = cur.execute("SELECT id FROM master_cards WHERE code=?", (SHIELD_CARD,)).fetchone()
    v2_card = cur.execute("SELECT id FROM master_cards WHERE code=?", (V2_CARD,)).fetchone()
    if not shield_card or not v2_card:
        raise RuntimeError("master_cards missing after insert")
    shield_card_id, v2_card_id = shield_card[0], v2_card[0]

    cur.execute("DELETE FROM master_card_members WHERE card_id=?", (shield_card_id,))
    rows = cur.execute(
        "SELECT strategy_id, weight, member_role, is_enabled, notes FROM master_card_members WHERE card_id=? AND is_enabled=1",
        (v2_card_id,),
    ).fetchall()
    copied = set()
    for row in rows:
        cur.execute(
            """
            INSERT INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (shield_card_id, row[0], row[1], row[2], row[3], row[4] or "from balanced-v2"),
        )
        copied.add(row[0])
    # Preserve DCA overlay members already on master TS
    dca_rows = cur.execute(
        """
        SELECT tsm.strategy_id, tsm.weight, tsm.member_role, tsm.is_enabled, tsm.notes
        FROM trading_system_members tsm
        JOIN strategies s ON s.id = tsm.strategy_id
        WHERE tsm.system_id = ? AND tsm.is_enabled = 1 AND s.strategy_type = 'dca'
        """,
        (ts_id,),
    ).fetchall()
    for row in dca_rows:
        if row[0] in copied:
            continue
        cur.execute(
            """
            INSERT INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
            VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
            """,
            (shield_card_id, row[0], row[1], row[2], row[3], row[4] or "dca overlay"),
        )
        copied.add(row[0])
    print(f"master_card {SHIELD_CARD}: {len(copied)} members (v2 + dca)")

    cur.execute(
        "UPDATE trading_systems SET max_open_positions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (CARD_METADATA["maxOpenPositions"], ts_id),
    )


def apply_dca_on_master() -> None:
    print("Applying DCA SUI/TRX on master TS (may take several minutes)…")
    api_post("/api/saas/admin/ts-dca-pair-apply", DCA_APPLY_PAYLOAD, timeout=1800)
    print("DCA apply OK")


def list_v2_clients(cur: sqlite3.Cursor) -> list[tuple[int, str]]:
    return cur.execute(
        """
        SELECT t.id, t.slug FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE t.status='active' AND ap.published_system_name=?
        ORDER BY t.slug
        """,
        (V2_SYSTEM,),
    ).fetchall()


def switch_client(cur: sqlite3.Cursor, tenant_id: int, slug: str) -> None:
    cur.execute(
        """
        UPDATE algofund_profiles
        SET published_system_name=?, updated_at=CURRENT_TIMESTAMP
        WHERE tenant_id=?
        """,
        (SHIELD_SYSTEM, tenant_id),
    )
    cur.connection.commit()
    api_post(f"/api/saas/algofund/{tenant_id}/retry-materialize", {}, timeout=600)
    print(f"  ✓ {slug} materialized on {SHIELD_SYSTEM}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup-only", action="store_true")
    parser.add_argument("--pilot", metavar="SLUG", help="Migrate single tenant slug")
    parser.add_argument("--all", action="store_true")
    parser.add_argument("--yes", action="store_true", help="Skip confirmation for --all")
    parser.add_argument("--skip-dca", action="store_true")
    args = parser.parse_args()

    with conn() as db:
        cur = db.cursor()
        setup_master_card(cur)
        db.commit()

    if not args.skip_dca:
        apply_dca_on_master()

    if args.setup_only:
        print("Setup complete.")
        return

    with conn() as db:
        cur = db.cursor()
        clients = list_v2_clients(cur)

    if args.pilot:
        target = args.pilot.strip()
        match = [(tid, slug) for tid, slug in clients if slug == target]
        if not match:
            raise RuntimeError(f"Pilot slug not on v2: {target}")
        print(f"Pilot switch: {target}")
        with conn() as db:
            switch_client(db.cursor(), match[0][0], match[0][1])
        return

    if args.all:
        if not args.yes:
            raise RuntimeError("Use --yes to confirm batch migration")
        print(f"Batch switch {len(clients)} clients…")
        for tenant_id, slug in clients:
            try:
                with conn() as db:
                    switch_client(db.cursor(), tenant_id, slug)
                time.sleep(2)
            except Exception as exc:
                print(f"  ✗ {slug}: {exc}")
        print("Batch done.")
        return

    print(f"Ready. Clients on v2: {len(clients)}")
    print("  --pilot btdd-d1   then   --all --yes")


if __name__ == "__main__":
    main()

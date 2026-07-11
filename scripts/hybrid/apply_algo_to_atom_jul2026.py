#!/usr/bin/env python3
"""Apply ZEN/ALGO → ZEN/ATOM on master cards/systems + rematerialize clients."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

# preview clones created earlier on VPS
REPLACEMENTS: dict[int, int] = {
    254536: 254931,  # futures ZZ_Fast ZEN/ALGO 4h → ZEN/ATOM
    254905: 254932,  # spot ZZ_Fast ZEN/ALGO 4h → ZEN/ATOM
}

MASTER_SYSTEM_IDS = {200, 201, 204, 205, 208, 209}
MASTER_CARD_IDS = {72, 73, 76, 77, 81, 82}

# also replace older ALGO template if still hanging on unused masters
EXTRA_ALGO_TO_ATOM = {
    241191: 254931,  # old ZEN/ALGO on union-synth-heavy masters
}


def api_post(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    data = r.json()
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def system_has_strategy(cur: sqlite3.Cursor, system_id: int, strategy_id: int) -> bool:
    row = cur.execute(
        "SELECT 1 FROM trading_system_members WHERE system_id=? AND strategy_id=? LIMIT 1",
        (system_id, strategy_id),
    ).fetchone()
    return row is not None


def replace_in_table(
    cur: sqlite3.Cursor,
    table: str,
    parent_col: str,
    mapping: dict[int, int],
    parent_filter: set[int] | None = None,
) -> int:
    changed = 0
    rows = cur.execute(
        f"SELECT {parent_col}, strategy_id FROM {table} WHERE strategy_id IN ({','.join('?' * len(mapping))})",
        list(mapping.keys()),
    ).fetchall()
    for parent_id, old_sid in rows:
        parent_id = int(parent_id)
        old_sid = int(old_sid)
        if parent_filter is not None and parent_id not in parent_filter:
            continue
        new_sid = mapping[old_sid]
        if table == "trading_system_members" and system_has_strategy(cur, parent_id, new_sid):
            cur.execute(
                f"DELETE FROM {table} WHERE {parent_col}=? AND strategy_id=?",
                (parent_id, old_sid),
            )
            print(f"  {table} parent={parent_id}: drop {old_sid} (already has {new_sid})")
            changed += 1
            continue
        if table == "master_card_members" and cur.execute(
            "SELECT 1 FROM master_card_members WHERE card_id=? AND strategy_id=? LIMIT 1",
            (parent_id, new_sid),
        ).fetchone():
            cur.execute(
                f"DELETE FROM {table} WHERE {parent_col}=? AND strategy_id=?",
                (parent_id, old_sid),
            )
            print(f"  {table} card={parent_id}: drop {old_sid} (already has {new_sid})")
            changed += 1
            continue
        n = cur.execute(
            f"UPDATE {table} SET strategy_id=? WHERE {parent_col}=? AND strategy_id=?",
            (new_sid, parent_id, old_sid),
        ).rowcount
        if n:
            print(f"  {table} parent={parent_id}: {old_sid} → {new_sid}")
            changed += n
    return changed


def list_rematerialize_targets(cur: sqlite3.Cursor) -> list[tuple[int, str, str]]:
    return cur.execute(
        """
        SELECT DISTINCT t.id, t.slug, COALESCE(ap.published_system_name, '')
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.actual_enabled, 0) = 1
          AND (
            ap.published_system_name LIKE '%synth-stable-union-v4-4-safe%'
            OR ap.published_system_name LIKE '%synth-stable-union-v4-4-b3%'
            OR ap.published_system_name LIKE '%tv-momentum-cloud-1-2-l400%'
            OR ap.published_system_name LIKE '%tv-frequency-stack-turbo%'
            OR ap.published_system_name LIKE '%spot-shield%'
            OR ap.published_system_name LIKE '%spot-balanced%'
            OR EXISTS (
              SELECT 1
              FROM trading_systems ts
              JOIN trading_system_members tsm ON tsm.system_id = ts.id
              JOIN strategies s ON s.id = tsm.strategy_id
              JOIN api_keys a ON a.id = ts.api_key_id
              WHERE a.name = ap.execution_api_key_name
                AND s.quote_symbol = 'ALGOUSDT'
                AND COALESCE(s.is_archived, 0) = 0
            )
          )
        ORDER BY t.slug
        """,
    ).fetchall()


def verify_master_algo(cur: sqlite3.Cursor) -> list[tuple]:
    return cur.execute(
        """
        SELECT ts.id, ts.name, s.id, s.base_symbol, s.quote_symbol, s.market_type
        FROM trading_system_members tsm
        JOIN trading_systems ts ON ts.id = tsm.system_id
        JOIN strategies s ON s.id = tsm.strategy_id
        WHERE ts.id IN (200,201,204,205,208,209)
          AND s.quote_symbol = 'ALGOUSDT'
        ORDER BY ts.id
        """,
    ).fetchall()


def audit_open_algo(cur: sqlite3.Cursor) -> list[tuple]:
    return cur.execute(
        """
        SELECT s.id, a.name, s.name, s.state, s.is_active, s.is_archived
        FROM strategies s
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE s.quote_symbol = 'ALGOUSDT'
          AND COALESCE(s.is_archived, 0) = 0
          AND s.is_active = 1
        ORDER BY a.name, s.id
        """,
    ).fetchall()


def main() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    for sid in (254931, 254932):
        row = cur.execute(
            "SELECT id, base_symbol, quote_symbol, market_type FROM strategies WHERE id=?",
            (sid,),
        ).fetchone()
        if not row:
            raise SystemExit(f"missing ATOM clone strategy id={sid}")
        print(f"OK clone {row}")

    mapping = dict(REPLACEMENTS)
    mapping.update(EXTRA_ALGO_TO_ATOM)

    print("=== patch master_card_members (scoped cards) ===")
    n1 = replace_in_table(cur, "master_card_members", "card_id", REPLACEMENTS, MASTER_CARD_IDS)
    print(f"  changed={n1}")

    print("=== patch trading_system_members (scoped masters) ===")
    n2 = replace_in_table(cur, "trading_system_members", "system_id", REPLACEMENTS, MASTER_SYSTEM_IDS)
    print(f"  changed={n2}")

    print("=== patch leftover ALGO on other BTDD_D1 masters (241191) ===")
    n3 = replace_in_table(cur, "trading_system_members", "system_id", EXTRA_ALGO_TO_ATOM, None)
    n4 = replace_in_table(cur, "master_card_members", "card_id", EXTRA_ALGO_TO_ATOM, None)
    print(f"  changed systems={n3} cards={n4}")

    conn.commit()

    bad = verify_master_algo(cur)
    if bad:
        print("WARNING: ALGO still on scoped masters:")
        for row in bad:
            print(" ", row)
    else:
        print("OK: no ALGO on scoped master systems 200/201/204/205/208/209")

    clients = list_rematerialize_targets(cur)
    print(f"=== rematerialize {len(clients)} clients ===")
    ok = 0
    for tid, slug, sysname in clients:
        try:
            api_post(f"/api/saas/algofund/{tid}/retry-materialize", {}, timeout=900)
            print(f"  ✓ {slug} ({sysname[:60]})")
            ok += 1
        except Exception as exc:
            print(f"  ✗ {slug}: {exc}")
        time.sleep(0.4)

    leftover = audit_open_algo(cur)
    print(f"=== rematerialize done ok={ok}/{len(clients)} ===")
    print(f"=== active non-archived ALGO strategies left: {len(leftover)} ===")
    for row in leftover[:40]:
        print(" ", row)

    print("done")


if __name__ == "__main__":
    main()

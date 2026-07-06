#!/usr/bin/env python3
"""Apply exchange-safe pair substitutions to B3 master (system 193) + rematerialize clients."""
from __future__ import annotations

import os
import sqlite3
import time

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

B3_SYSTEM_ID = int(os.environ.get("B3_SYSTEM_ID", "193"))
B3_SYSTEM = os.environ.get(
    "B3_SYSTEM",
    "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-4-b3-jul2026-8mws9",
)

# old_strategy_id -> new_strategy_id (None = already dropped)
REPLACEMENTS: dict[int, int] = {
    242970: 239252,  # BERA/IP → BERA mono CT
    242976: 239277,  # TRU/GRT → INJ/TIA
    242968: 239259,  # STX/IMX → FIL mono CT
    254034: 254046,  # TV IPUSDT → TIAUSDT
    242972: 241737,  # LINK/AIXBT CT 4h → LINK/UNI CT 4h (WEEX -1058)
    241189: 241503,  # LINK/AIXBT ZZ 1d → LINK/UNI ZZ 1d (WEEX -1058)
}


def api_post(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    data = r.json()
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def replace_members(cur: sqlite3.Cursor, table: str, id_col: str, parent_id: int) -> None:
    for old_sid, new_sid in REPLACEMENTS.items():
        n = cur.execute(
            f"UPDATE {table} SET strategy_id=? WHERE {id_col}=? AND strategy_id=?",
            (new_sid, parent_id, old_sid),
        ).rowcount
        if n:
            print(f"  {table}: {old_sid} → {new_sid} ({n} row)")


def list_b3_clients(cur: sqlite3.Cursor) -> list[tuple[int, str]]:
    return cur.execute(
        """
        SELECT t.id, t.slug
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.actual_enabled, 0) = 1
          AND LOWER(COALESCE(ap.published_system_name, '')) LIKE '%b3%'
        ORDER BY t.slug
        """,
    ).fetchall()


def main() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    before = cur.execute(
        "SELECT COUNT(*) FROM trading_system_members WHERE system_id=?",
        (B3_SYSTEM_ID,),
    ).fetchone()[0]
    print(f"B3 system {B3_SYSTEM_ID}: {before} members before patch")

    replace_members(cur, "trading_system_members", "system_id", B3_SYSTEM_ID)

    card = cur.execute(
        "SELECT id FROM master_cards WHERE source_system_id=?",
        (B3_SYSTEM_ID,),
    ).fetchone()
    if card:
        replace_members(cur, "master_card_members", "card_id", int(card[0]))

    conn.commit()

    after = cur.execute(
        "SELECT COUNT(*) FROM trading_system_members WHERE system_id=?",
        (B3_SYSTEM_ID,),
    ).fetchone()[0]
    print(f"B3 members after: {after}")

    # Verify no bad pairs remain
    bad = cur.execute(
        """
        SELECT m.strategy_id, s.base_symbol, s.quote_symbol
        FROM trading_system_members m
        JOIN strategies s ON s.id = m.strategy_id
        WHERE m.system_id = ?
          AND (
            (s.base_symbol='IPUSDT' AND s.quote_symbol != '')
            OR s.base_symbol IN ('TRUUSDT','STXUSDT')
            OR (s.base_symbol='IPUSDT' AND s.strategy_type='momentum_scalp_tv')
          )
        """,
        (B3_SYSTEM_ID,),
    ).fetchall()
    if bad:
        raise RuntimeError(f"still has unavailable legs: {bad}")

    clients = list_b3_clients(cur)
    print(f"Rematerializing {len(clients)} B3 clients...")
    for tid, slug in clients:
        try:
            api_post(f"/api/saas/algofund/{tid}/retry-materialize", {}, timeout=900)
            print(f"  ✓ {slug}")
        except Exception as exc:
            print(f"  ✗ {slug}: {exc}")
        time.sleep(1)

    print("done")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Replace WEEX-denied synth legs in master systems/cards + rematerialize SaaS clients."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from pathlib import Path

import requests

REPO = Path(__file__).resolve().parents[3]
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", str(REPO / "backend" / "database.db"))

# old_strategy_id -> new_strategy_id on BTDD_D1 master templates
REPLACEMENTS: dict[int, int] = {
    242972: 241737,  # CT_Fractal 4h LINK/AIXBT → LINK/UNI
    241189: 241503,  # ZZ_Fast 1d LINK/AIXBT → LINK/UNI (pch 12)
}

DENIED_CFG = REPO / "backend" / "src" / "config" / "weex_saas_trade_denied.json"


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


def replace_in_table(cur: sqlite3.Cursor, table: str, parent_col: str) -> int:
    changed = 0
    rows = cur.execute(
        f"SELECT {parent_col}, strategy_id FROM {table} WHERE strategy_id IN ({','.join('?' * len(REPLACEMENTS))})",
        list(REPLACEMENTS.keys()),
    ).fetchall()
    for parent_id, old_sid in rows:
        new_sid = REPLACEMENTS[int(old_sid)]
        if table == "trading_system_members" and system_has_strategy(cur, int(parent_id), new_sid):
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


def disable_materialized_denied(cur: sqlite3.Cursor) -> int:
    denied_pairs = []
    if DENIED_CFG.is_file():
        doc = json.loads(DENIED_CFG.read_text(encoding="utf-8"))
        for raw in doc.get("synthPairs") or []:
            parts = str(raw).upper().replace("_", "/").split("/")
            if len(parts) == 2:
                denied_pairs.append((parts[0], parts[1]))
    denied_pairs.append(("LINKUSDT", "AIXBTUSDT"))

    n = 0
    for base, quote in denied_pairs:
        n += cur.execute(
            """
            UPDATE strategies
            SET is_active=0,
                auto_update=0,
                last_action='weex_pair_denied_archived',
                last_error='weex -1058 trade denied (migration jul2026)',
                updated_at=CURRENT_TIMESTAMP
            WHERE base_symbol=? AND quote_symbol=?
              AND is_active=1
              AND api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'artursk%')
            """,
            (base, quote),
        ).rowcount
    return n


def list_rematerialize_targets(cur: sqlite3.Cursor) -> list[tuple[int, str]]:
    return cur.execute(
        """
        SELECT DISTINCT t.id, t.slug
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE COALESCE(ap.actual_enabled, 0) = 1
          AND COALESCE(ap.requested_enabled, 0) = 1
          AND (
            ap.published_system_name LIKE '%synth-stable-union%'
            OR ap.published_system_name LIKE '%tv-momentum-cloud%'
            OR ap.published_system_name LIKE '%union-synth-heavy%'
            OR t.slug LIKE 'artursk%'
          )
        ORDER BY t.slug
        """,
    ).fetchall()


def verify_no_denied_in_masters(cur: sqlite3.Cursor) -> list[tuple]:
    return cur.execute(
        """
        SELECT ts.id, ts.name, s.id, s.base_symbol, s.quote_symbol
        FROM trading_system_members tsm
        JOIN trading_systems ts ON ts.id = tsm.system_id
        JOIN strategies s ON s.id = tsm.strategy_id
        JOIN api_keys a ON a.id = ts.api_key_id
        WHERE a.name = 'BTDD_D1'
          AND (
            s.quote_symbol = 'AIXBTUSDT'
            OR s.base_symbol = 'AIXBTUSDT'
            OR (s.base_symbol, s.quote_symbol) IN (
              ('LINKUSDT','AIXBTUSDT'),
              ('ZECUSDT','RUNEUSDT'),
              ('IPUSDT','ZECUSDT'),
              ('ORDIUSDT','ZECUSDT')
            )
          )
        ORDER BY ts.id, s.id
        """,
    ).fetchall()


def main() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()

    print("=== patch master_card_members ===")
    replace_in_table(cur, "master_card_members", "card_id")

    print("=== patch trading_system_members (all systems) ===")
    replace_in_table(cur, "trading_system_members", "system_id")

    disabled = disable_materialized_denied(cur)
    print(f"=== disabled {disabled} active artursk denied synth legs ===")

    conn.commit()

    bad = verify_no_denied_in_masters(cur)
    if bad:
        print("WARNING: denied legs still in BTDD_D1 master systems:")
        for row in bad:
            print(" ", row)
    else:
        print("OK: no denied legs in BTDD_D1 master systems")

    clients = list_rematerialize_targets(cur)
    print(f"=== rematerialize {len(clients)} clients ===")
    for tid, slug in clients:
        try:
            api_post(f"/api/saas/algofund/{tid}/retry-materialize", {}, timeout=900)
            print(f"  ✓ {slug}")
        except Exception as exc:
            print(f"  ✗ {slug}: {exc}")
        time.sleep(0.5)

    print("done")


if __name__ == "__main__":
    main()

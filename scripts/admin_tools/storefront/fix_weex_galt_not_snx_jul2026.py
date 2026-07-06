#!/usr/bin/env python3
"""WEEX denied GRT/ALT/NOT/SNX — bake replacements + patch masters + rematerialize artursk."""
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
MASTER_API = "BTDD_D1"
DENIED_CFG = REPO / "backend" / "src" / "config" / "weex_saas_trade_denied.json"

# old_strategy_id -> new_strategy_id (resolved at runtime if missing)
REPLACEMENTS_BY_NAME: dict[int, str] = {
    242966: "SYNTH4H_CTF_20260701_CTF_S_INJUSDT_TIAUSDT_4h_L12_ZE1_5_ZX0_25_ZS2",  # INJ/GRT → INJ/TIA 4h
    242965: "SYNTH4H_V2_20260702_CTF_S_MANTAUSDT_APTUSDT_4h_L36_ZE2_5_ZX0_75_ZS2_5",
    254031: "TV_BURST_15M_NEARUSDT",
    254033: "TV_BURST_15M_INJUSDT",
    254043: "TV_BURST_15M_TONUSDT",
    254041: "TV_BURST_15M_COMPUSDT",
}

BAKE_NAMES = [
    "SYNTH4H_V2_20260702_CTF_S_MANTAUSDT_APTUSDT_4h_L36_ZE2_5_ZX0_75_ZS2_5",
    "TV_BURST_15M_NEARUSDT",
    "TV_BURST_15M_INJUSDT",
    "TV_BURST_15M_TONUSDT",
    "TV_BURST_15M_COMPUSDT",
]

DENIED_MONO = ["GRTUSDT", "ALTUSDT", "NOTUSDT", "SNXUSDT"]
DENIED_SYNTH = [("INJUSDT", "GRTUSDT"), ("MANTAUSDT", "ALTUSDT")]


def api_post(path: str, payload: dict | None = None, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    data = r.json()
    if data.get("success") is False and data.get("error"):
        raise RuntimeError(str(data["error"]))
    return data


def master_key_id(cur: sqlite3.Cursor) -> int:
    row = cur.execute("SELECT id FROM api_keys WHERE name=?", (MASTER_API,)).fetchone()
    if not row:
        raise RuntimeError(f"missing api key {MASTER_API}")
    return int(row[0])


def resolve_sid(cur: sqlite3.Cursor, ak_id: int, name: str) -> int:
    row = cur.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND name=? ORDER BY id DESC LIMIT 1",
        (ak_id, name),
    ).fetchone()
    if not row:
        raise RuntimeError(f"missing master strategy {name}")
    return int(row[0])


def build_replacements(cur: sqlite3.Cursor) -> dict[int, int]:
    ak_id = master_key_id(cur)
    out: dict[int, int] = {}
    for old_sid, new_name in REPLACEMENTS_BY_NAME.items():
        new_sid = resolve_sid(cur, ak_id, new_name)
        out[int(old_sid)] = new_sid
        print(f"  map {old_sid} → {new_sid} ({new_name})")
    return out


def activate_baked(cur: sqlite3.Cursor, ak_id: int) -> int:
    n = 0
    for name in BAKE_NAMES:
        n += cur.execute(
            """
            UPDATE strategies
            SET is_active=1, auto_update=1, last_error='', updated_at=CURRENT_TIMESTAMP
            WHERE api_key_id=? AND name=?
            """,
            (ak_id, name),
        ).rowcount
    return n


def system_has_strategy(cur: sqlite3.Cursor, system_id: int, strategy_id: int) -> bool:
    return (
        cur.execute(
            "SELECT 1 FROM trading_system_members WHERE system_id=? AND strategy_id=? LIMIT 1",
            (system_id, strategy_id),
        ).fetchone()
        is not None
    )


def replace_in_table(cur: sqlite3.Cursor, table: str, parent_col: str, replacements: dict[int, int]) -> int:
    changed = 0
    old_ids = list(replacements.keys())
    if not old_ids:
        return 0
    placeholders = ",".join("?" * len(old_ids))
    rows = cur.execute(
        f"SELECT {parent_col}, strategy_id FROM {table} WHERE strategy_id IN ({placeholders})",
        old_ids,
    ).fetchall()
    for parent_id, old_sid in rows:
        old_sid = int(old_sid)
        new_sid = replacements[old_sid]
        parent_id = int(parent_id)
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


def disable_materialized_denied(cur: sqlite3.Cursor) -> int:
    n = 0
    for sym in DENIED_MONO:
        n += cur.execute(
            """
            UPDATE strategies
            SET is_active=0, auto_update=0,
                last_action='weex_pair_denied_archived',
                last_error='weex -1058 trade denied (galt-not-snx jul2026)',
                updated_at=CURRENT_TIMESTAMP
            WHERE base_symbol=? AND COALESCE(quote_symbol,'')=''
              AND is_active=1
              AND api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'artursk%')
            """,
            (sym,),
        ).rowcount
    for base, quote in DENIED_SYNTH:
        n += cur.execute(
            """
            UPDATE strategies
            SET is_active=0, auto_update=0,
                last_action='weex_pair_denied_archived',
                last_error='weex -1058 trade denied (galt-not-snx jul2026)',
                updated_at=CURRENT_TIMESTAMP
            WHERE base_symbol=? AND quote_symbol=?
              AND is_active=1
              AND api_key_id IN (SELECT id FROM api_keys WHERE name LIKE 'artursk%')
            """,
            (base, quote),
        ).rowcount
    return n


def verify_masters(cur: sqlite3.Cursor) -> list[tuple]:
    """Only active storefront master systems (v4.2 / B3 / L400)."""
    return cur.execute(
        """
        SELECT ts.id, ts.name, s.id, s.base_symbol, s.quote_symbol
        FROM trading_system_members tsm
        JOIN trading_systems ts ON ts.id = tsm.system_id
        JOIN strategies s ON s.id = tsm.strategy_id
        JOIN master_cards mc ON mc.source_system_id = ts.id AND mc.is_active = 1
        JOIN api_keys a ON a.id = ts.api_key_id
        WHERE a.name = 'BTDD_D1'
          AND mc.id IN (58, 70, 71)
          AND (
            (s.base_symbol IN ('GRTUSDT','ALTUSDT','NOTUSDT','SNXUSDT')
             AND COALESCE(s.quote_symbol,'') = '')
            OR (s.base_symbol, s.quote_symbol) IN (
              ('INJUSDT','GRTUSDT'), ('MANTAUSDT','ALTUSDT')
            )
          )
        ORDER BY ts.id, s.id
        """,
    ).fetchall()


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
            OR t.slug LIKE 'artursk%'
          )
        ORDER BY t.slug
        """,
    ).fetchall()


def update_denied_config() -> None:
    doc = {
        "comment": "Pairs/symbols that return WEEX -1058 on SaaS subaccounts (klines OK, orders denied).",
        "synthPairs": [
            "LINKUSDT/AIXBTUSDT",
            "ZECUSDT/RUNEUSDT",
            "IPUSDT/ZECUSDT",
            "ORDIUSDT/ZECUSDT",
            "INJUSDT/GRTUSDT",
            "MANTAUSDT/ALTUSDT",
        ],
        "monoSymbols": [
            "AIXBTUSDT",
            "GRTUSDT",
            "ALTUSDT",
            "NOTUSDT",
            "SNXUSDT",
        ],
        "replacements": {
            "LINKUSDT/AIXBTUSDT": "LINKUSDT/UNIUSDT",
            "INJUSDT/GRTUSDT": "INJUSDT/TIAUSDT",
            "MANTAUSDT/ALTUSDT": "MANTAUSDT/APTUSDT",
            "ALTUSDT": "NEARUSDT",
            "GRTUSDT": "INJUSDT",
            "NOTUSDT": "TONUSDT",
            "SNXUSDT": "COMPUSDT",
        },
    }
    DENIED_CFG.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")
    print(f"updated {DENIED_CFG}")


def main() -> None:
    conn = sqlite3.connect(DB)
    cur = conn.cursor()
    ak_id = master_key_id(cur)

    print("=== activate baked master strategies ===")
    activated = activate_baked(cur, ak_id)
    print(f"activated {activated} rows")

    print("=== resolve replacements ===")
    replacements = build_replacements(cur)

    print("=== patch master_card_members ===")
    replace_in_table(cur, "master_card_members", "card_id", replacements)

    print("=== patch trading_system_members (BTDD_D1 masters) ===")
    replace_in_table(cur, "trading_system_members", "system_id", replacements)

    disabled = disable_materialized_denied(cur)
    print(f"=== disabled {disabled} active artursk denied legs ===")

    conn.commit()

    bad = verify_masters(cur)
    if bad:
        raise RuntimeError(f"denied legs still in BTDD_D1 masters: {bad}")
    print("OK: no denied legs in BTDD_D1 master systems")

    for sys_id in (186, 193, 198):
        cnt = cur.execute(
            "SELECT COUNT(*) FROM trading_system_members WHERE system_id=? AND is_enabled=1",
            (sys_id,),
        ).fetchone()[0]
        print(f"system {sys_id}: {cnt} members")

    update_denied_config()

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

#!/usr/bin/env python3
"""Disable CT_Fractal legs tied to FIL / PENDLE / ORDI on live B3 clients."""
from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

# Master source SIDs (from ::SID suffix in strategy names)
DISABLED_SOURCE_SIDS = (
    "239259",  # MONO FILUSDT
    "239282",  # SYNTH ORDIUSDT/ZECUSDT
    "242969",  # SYNTH PENDLEUSDT/EIGENUSDT
    "242974",  # SYNTH NEARUSDT/FILUSDT
)

FLAG_KEY = "runtime.ct_fractal_disabled_source_sids"
B3_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-4-b3-jul2026-8mws9"


def sid_clause(alias: str = "s") -> str:
    return " OR ".join(f"{alias}.name LIKE '%::SID{sid}'" for sid in DISABLED_SOURCE_SIDS)


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    sid_filter = sid_clause("s")
    rows = conn.execute(
        f"""
        SELECT s.id, s.name, a.name AS api
        FROM strategies s
        JOIN api_keys a ON a.id = s.api_key_id
        LEFT JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name
        WHERE s.strategy_type = 'CT_Fractal'
          AND s.is_active = 1
          AND ({sid_filter})
          AND (
            (ap.actual_enabled = 1 AND ap.published_system_name LIKE '%b3-jul2026%')
            OR a.name = 'BTDD_D1'
          )
        """
    ).fetchall()

    disabled_rows = [{"api": r["api"], "id": int(r["id"]), "name": r["name"]} for r in rows]
    if disabled_rows:
        ids = [r["id"] for r in disabled_rows]
        placeholders = ",".join("?" * len(ids))
        conn.execute(
            f"""UPDATE strategies SET is_active = 0, auto_update = 0, state = 'flat',
                    entry_ratio = NULL, tp_anchor_ratio = NULL,
                    last_action = 'ct_fractal_leg_disabled_jul2026',
                    updated_at = CURRENT_TIMESTAMP WHERE id IN ({placeholders})""",
            ids,
        )

    # trading_system_members for B3 master card
    ts = conn.execute(
        "SELECT id FROM trading_systems WHERE name = ? LIMIT 1",
        (B3_SYSTEM,),
    ).fetchone()
    tsm_disabled = 0
    if ts:
        tsm_disabled = conn.execute(
            f"""
            UPDATE trading_system_members
            SET is_enabled = 0
            WHERE system_id = ?
              AND strategy_id IN (
                SELECT s.id FROM strategies s
                WHERE s.strategy_type = 'CT_Fractal' AND ({sid_clause('s')})
              )
            """,
            (int(ts["id"]),),
        ).rowcount

    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "reason": "live win ~6% on FIL/PENDLE/ORDI vs positive backtest legs",
        "sourceSids": list(DISABLED_SOURCE_SIDS),
        "disabledCount": len(disabled_rows),
        "tsmDisabled": tsm_disabled,
        "sample": disabled_rows[:8],
    }
    conn.execute(
        """
        INSERT INTO app_runtime_flags(key, value, updated_at)
        VALUES (?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
        """,
        (FLAG_KEY, json.dumps(payload, ensure_ascii=False)),
    )
    conn.commit()

    print(f"disabled strategies: {len(disabled_rows)}")
    print(f"trading_system_members patched: {tsm_disabled}")
    for sid in DISABLED_SOURCE_SIDS:
        n = sum(1 for r in disabled_rows if f"::SID{sid}" in r["name"])
        print(f"  SID{sid}: {n}")
    print("flag", FLAG_KEY)

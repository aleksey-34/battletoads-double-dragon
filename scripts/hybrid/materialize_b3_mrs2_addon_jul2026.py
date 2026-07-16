#!/usr/bin/env python3
"""
B3 + top MRS2 addon @0.5x — draft-only recipe, never mutates the live B3 system.

Clones the B3 core system's members into a NEW draft trading system and appends
the top WEEX-available MRS2 mono legs (from b3_cross_results.json) at
0.5x their hamster bal_pct lot (falls back to a flat 3% if bal_pct missing).

Always writes the JSON recipe:
  results/hamster_compound_system89_jul2026/b3_mrs2_addon_card.json

--apply materializes the DRAFT system (new trading_systems row, new name) into
the DB that actually holds the B3 system (auto-detected via B3_SYSTEM_ID, or
override with DB_FILE / --b3-system-id). The live B3 system itself (id from
b3_cross_results.json, default 205) and its members are only ever READ, never
written.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
B3_CROSS = os.path.join(REPO, "results/hamster_compound_system89_jul2026/b3_cross_results.json")
MAPPED = os.path.join(REPO, "results/hamster_compound_system89_jul2026/mapped_for_btdd.json")
WEEX_AVAIL = os.path.join(REPO, "results/hamster_compound_system89_jul2026/weex_availability.json")
OUT = os.path.join(REPO, "results/hamster_compound_system89_jul2026/b3_mrs2_addon_card.json")

# Candidate DBs to auto-detect the live B3 system in, in priority order.
_CANDIDATE_DBS = [
    os.environ.get("DB_FILE") or "",
    os.path.join(REPO, "backend", "database.db"),
    os.path.join(REPO, "backend", "database.db.flat_comp"),
    os.path.join(REPO, "backend", "database.db.hybrid_slim"),
]

API_KEY_NAME = os.environ.get("B3_ADDON_API_KEY", "BTDD_D1")
ADDON_SET_KEY_SUFFIX = os.environ.get("B3_ADDON_SET_KEY_SUFFIX", "b3-mrs2-addon-jul2026")
ADDON_LOT_MULT = float(os.environ.get("B3_ADDON_LOT_MULT", "0.5"))
ADDON_FLAT_LOT = float(os.environ.get("B3_ADDON_FLAT_LOT", "3.0"))
ADDON_MAX_OPEN_POSITIONS_BUMP = int(os.environ.get("B3_ADDON_OP_BUMP", "6"))
STRATEGY_PREFIX = "MRS2_B3ADDON"

TOP_MRS2_SYMBOLS = ["LYNUSDT", "ROBOUSDT", "ACUUSDT", "XVGUSDT", "SCRUSDT", "ELSAUSDT"]

MISSING_SYMBOLS = {"BOBBOBUSDT", "BRUSDT", "CFGUSDT", "DEXEUSDT", "LITUSDT", "QUSDT"}
ALIAS_MAP = {
    "1000LUNCUSDT": "LUNCUSDT",
    "AMDSTOCKUSDT": "AMDUSDT",
    "LUNA2USDT": "LUNAUSDT",
    "PUMPFUNUSDT": "PUMPUSDT",
}


def find_db_with_system(system_id: int) -> str | None:
    for path in _CANDIDATE_DBS:
        if not path or not os.path.isfile(path):
            continue
        try:
            conn = sqlite3.connect(path)
            row = conn.execute("SELECT id FROM trading_systems WHERE id=?", (system_id,)).fetchone()
            conn.close()
        except sqlite3.Error:
            continue
        if row:
            return path
    return None


def load_b3_meta() -> tuple[int, str]:
    data = json.load(open(B3_CROSS, encoding="utf-8"))
    return int(data.get("b3SystemId") or 205), str(data.get("card") or "")


def load_weex_meta() -> dict[str, dict]:
    data = json.load(open(WEEX_AVAIL, encoding="utf-8"))
    return {str(row.get("symbol") or "").upper(): row for row in (data.get("symbols") or [])}


def safe_float(val, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def build_addon_legs() -> list[dict]:
    rows = json.load(open(MAPPED, encoding="utf-8"))
    by_symbol = {
        str(r["symbol"]).upper(): r
        for r in rows
        if str(r.get("strategy") or "").lower() == "mrs2"
    }
    weex_meta = load_weex_meta()
    legs: list[dict] = []
    for symbol in TOP_MRS2_SYMBOLS:
        row = by_symbol.get(symbol)
        if not row:
            print(f"WARN {symbol}: not found in mapped_for_btdd mrs2 legs, skipped")
            continue
        if symbol in MISSING_SYMBOLS:
            print(f"WARN {symbol}: not on WEEX, skipped")
            continue
        meta = weex_meta.get(symbol) or {}
        if meta and meta.get("available") is False:
            print(f"WARN {symbol}: weex_availability marks unavailable, skipped")
            continue
        weex_symbol = ALIAS_MAP.get(symbol, meta.get("weex_symbol") or symbol)
        bal_pct = safe_float(row.get("bal_pct"), 0.0)
        base_lot = bal_pct if bal_pct > 0 else ADDON_FLAT_LOT
        addon_lot = round(base_lot * ADDON_LOT_MULT, 3)
        leverage = safe_float(row.get("leverage"), 20.0)
        max_lev = meta.get("max_leverage")
        if max_lev:
            leverage = min(leverage, safe_float(max_lev, leverage))
        ma_len = int(safe_float(row.get("mrs_ma_len"), 5))
        legs.append({
            "hamsterSymbol": symbol,
            "weexSymbol": weex_symbol,
            "aliased": weex_symbol != symbol,
            "tf": str(row.get("tf") or "4h"),
            "leverage": leverage,
            "slLongPct": safe_float(row.get("sl_long"), 0.0),
            "mrsMaLen": ma_len,
            "mrsMultLong": safe_float(row.get("mrs_mult_long"), 0.95),
            "mrsMultShort": safe_float(row.get("mrs_mult_short"), 1.05),
            "mrsCloseLen": int(safe_float(row.get("mrs_close_len"), ma_len)),
            "mrsDist": safe_float(row.get("mrs_dist"), 0.3),
            "btPnl": safe_float(row.get("bt_pnl"), 0.0),
            "btPf": safe_float(row.get("bt_pf"), 1.0),
            "balPct": bal_pct,
            "addonLotPercent": addon_lot,
        })
    return legs


def mrs2_config_json(leg: dict) -> str:
    return json.dumps({
        "maLongLen": leg["mrsMaLen"],
        "maLongMult": leg["mrsMultLong"],
        "maShortLen": leg["mrsMaLen"],
        "maShortMult": leg["mrsMultShort"],
        "maCloseLongLen": leg["mrsCloseLen"],
        "maCloseLongMult": 1.0,
        "maCloseShortLen": leg["mrsCloseLen"],
        "maCloseShortMult": 1.0,
        "distanceFilterPct": leg["mrsDist"],
        "slLongPct": leg["slLongPct"],
        "slShortPct": 0,
    })


def strategy_name(leg: dict) -> str:
    return f"{STRATEGY_PREFIX}_{leg['weexSymbol']}_{leg['tf']}"


def load_b3_members(conn: sqlite3.Connection, b3_system_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT s.id, s.name, s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol,
                  s.interval, tsm.weight
           FROM trading_system_members tsm
           JOIN strategies s ON s.id = tsm.strategy_id
           WHERE tsm.system_id = ? AND tsm.is_enabled = 1""",
        (b3_system_id,),
    ).fetchall()
    return [
        {
            "strategyId": int(r[0]),
            "strategyName": r[1],
            "strategyType": r[2],
            "marketMode": r[3],
            "market": f"{r[4]}/{r[5]}" if r[5] else r[4],
            "interval": r[6],
            "weight": float(r[7] or 1.0),
        }
        for r in rows
    ]


def ensure_api_key(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM api_keys WHERE name=?", (API_KEY_NAME,)).fetchone()
    if not row:
        raise SystemExit(f"api_key '{API_KEY_NAME}' not found — create it first")
    return int(row[0])


def upsert_addon_strategy(conn: sqlite3.Connection, api_key_id: int, leg: dict) -> int:
    name = strategy_name(leg)
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    cfg_json = mrs2_config_json(leg)
    if row:
        return int(row[0])
    conn.execute(
        """INSERT INTO strategies (
             name, api_key_id, strategy_type, market_mode, market_type, base_symbol, quote_symbol,
             interval, leverage, lot_long_percent, lot_short_percent, reinvest_percent,
             mrs2_config_json, price_channel_length, zscore_entry, zscore_exit, zscore_stop,
             take_profit_percent, detection_source, long_enabled, short_enabled, margin_type,
             is_active, display_on_chart, show_settings, show_chart, show_indicators,
             show_positions_on_chart, auto_update, fixed_lot, state
           ) VALUES (?, ?, 'MRS2', 'mono', 'futures', ?, '', ?, ?, ?, ?, 100, ?, ?, ?, ?, ?,
             0, 'wick', 1, 1, 'cross', 0, 1, 1, 1, 1, 1, 1, 0, 'flat')""",
        (
            name, api_key_id, leg["weexSymbol"], leg["tf"], leg["leverage"],
            leg["addonLotPercent"], leg["addonLotPercent"], cfg_json,
            leg["mrsMaLen"], leg["mrsMultLong"], leg["mrsMultShort"], leg["mrsDist"],
        ),
    )
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    return int(row[0])


def create_draft_system(
    conn: sqlite3.Connection,
    api_key_id: int,
    system_name: str,
    b3_members: list[dict],
    addon_ids: list[int],
    b3_max_open_positions: int,
) -> int:
    row = conn.execute(
        "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (api_key_id, system_name)
    ).fetchone()
    total_members = len(b3_members) + len(addon_ids)
    new_op = b3_max_open_positions + ADDON_MAX_OPEN_POSITIONS_BUMP
    if row:
        sys_id = int(row[0])
        conn.execute(
            "UPDATE trading_systems SET max_members=?, max_open_positions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (max(total_members, 8), new_op, sys_id),
        )
        conn.execute("UPDATE trading_system_members SET is_enabled=0 WHERE system_id=?", (sys_id,))
    else:
        conn.execute(
            """INSERT INTO trading_systems (api_key_id, name, description, is_active, max_members, max_open_positions, market_type)
               VALUES (?, ?, ?, 0, ?, ?, 'futures')""",
            (
                api_key_id, system_name,
                "DRAFT clone of B3 core + top WEEX MRS2 addon legs @0.5x lot (review only, not live).",
                max(total_members, 8), new_op,
            ),
        )
        row = conn.execute(
            "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (api_key_id, system_name)
        ).fetchone()
        sys_id = int(row[0])

    for m in b3_members:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'core', 1, 'b3_core_clone')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET
                 weight=excluded.weight, is_enabled=1, notes=excluded.notes""",
            (sys_id, m["strategyId"], m["weight"]),
        )
    for sid in addon_ids:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, 1.0, 'addon', 1, 'hamster_mrs2_addon')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET
                 weight=1.0, is_enabled=1, notes='hamster_mrs2_addon'""",
            (sys_id, sid),
        )
    return sys_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="materialize the DRAFT system into DB (never touches live B3)")
    parser.add_argument("--b3-system-id", type=int, default=0)
    args = parser.parse_args()

    b3_system_id, b3_card_key = load_b3_meta()
    if args.b3_system_id:
        b3_system_id = args.b3_system_id
    draft_set_key = os.environ.get("B3_ADDON_SET_KEY", ADDON_SET_KEY_SUFFIX)
    draft_system_name = f"ALGOFUND_MASTER::{API_KEY_NAME}::{draft_set_key}"

    addon_legs = build_addon_legs()

    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "b3SystemId": b3_system_id,
        "b3CardKey": b3_card_key,
        "draftSystemName": draft_system_name,
        "apiKeyName": API_KEY_NAME,
        "addonLotMultiplier": ADDON_LOT_MULT,
        "addonFlatLotFallback": ADDON_FLAT_LOT,
        "addonLegs": addon_legs,
        "note": "Draft clones B3 core members (weight preserved) + appends addon legs. Live B3 system is read-only, never mutated.",
    }

    db_path = find_db_with_system(b3_system_id)
    print(f"B3 system id={b3_system_id} card={b3_card_key!r}")
    print(f"Addon legs ({len(addon_legs)}):")
    for leg in addon_legs:
        alias_note = f" (alias of {leg['hamsterSymbol']})" if leg["aliased"] else ""
        print(
            f"  {leg['weexSymbol']:12}{alias_note:22} tf={leg['tf']:4} lev={leg['leverage']:.0f}x "
            f"balPct={leg['balPct']:.2f} -> addonLot={leg['addonLotPercent']:.2f}% btPnl={leg['btPnl']:.1f}"
        )

    if not db_path:
        print(f"\nNo local DB snapshot found containing trading_system id={b3_system_id}.")
        print("JSON recipe still written (addon legs + params); rerun with DB_FILE=<path to DB with B3> to --apply.")
        os.makedirs(os.path.dirname(OUT), exist_ok=True)
        json.dump(card, open(OUT, "w"), indent=2, ensure_ascii=False)
        print(f"Wrote {OUT}")
        return

    print(f"Found B3 system in: {db_path}")

    conn = sqlite3.connect(db_path)
    try:
        b3_row = conn.execute(
            "SELECT max_open_positions, name FROM trading_systems WHERE id=?", (b3_system_id,)
        ).fetchone()
        b3_op = int(b3_row[0]) if b3_row else 12
        b3_members = load_b3_members(conn, b3_system_id)
        card["b3MembersCloned"] = len(b3_members)
        card["b3Members"] = b3_members
    finally:
        conn.close()

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(card, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"Wrote {OUT}")
    print(f"B3 core has {len(b3_members)} enabled members (read-only clone source).")

    if not args.apply:
        print(f"\nDry-run only. Draft system would be: {draft_system_name}")
        print("Pass --apply to materialize the draft (new trading_systems row; live B3 untouched).")
        return

    conn = sqlite3.connect(db_path)
    try:
        api_key_id = ensure_api_key(conn)
        addon_ids = [upsert_addon_strategy(conn, api_key_id, leg) for leg in addon_legs]
        sys_id = create_draft_system(conn, api_key_id, draft_system_name, b3_members, addon_ids, b3_op)
        conn.commit()
    finally:
        conn.close()

    card["draftSystemId"] = sys_id
    card["addonStrategyIds"] = addon_ids
    json.dump(card, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"\nApplied: draft system_id={sys_id} ({draft_system_name}) in {db_path}")
    print(f"  {len(b3_members)} cloned B3 members + {len(addon_ids)} MRS2 addon legs, all is_active=0 (paused).")
    print(f"  Live B3 system id={b3_system_id} was only read, not modified.")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
MRS2-only WEEX pilot card — OP16, lot 6%, WEEX-tradable symbols only.

Sources:
  results/hamster_compound_system89_jul2026/mapped_for_btdd.json   (hamster MRS2 legs + params)
  results/hamster_compound_system89_jul2026/weex_availability.json (WEEX symbol/alias coverage)

Dry-run (default): just prints the picked legs and writes the JSON card artifact.
  python3 scripts/hybrid/build_mrs2_weex_pilot_card_jul2026.py

Apply (writes strategies + trading system to local DB, api_key_id/name = BTDD_D1):
  python3 scripts/hybrid/build_mrs2_weex_pilot_card_jul2026.py --apply

DB_FILE env var overrides target DB (defaults to backend/database.db).
Strategies are created with is_active=0 (paused) — activate deliberately before
attaching a real client/key.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
MAPPED = os.path.join(REPO, "results/hamster_compound_system89_jul2026/mapped_for_btdd.json")
WEEX_AVAIL = os.path.join(REPO, "results/hamster_compound_system89_jul2026/weex_availability.json")
OUT = os.path.join(REPO, "results/hamster_compound_system89_jul2026/mrs2_weex_pilot_card.json")

DB = os.environ.get("DB_FILE") or os.path.join(REPO, "backend", "database.db")
API_KEY_NAME = os.environ.get("MRS2_PILOT_API_KEY", "BTDD_D1")
SET_KEY = os.environ.get("MRS2_PILOT_SET_KEY", "mrs2-weex-pilot-op16-jul2026")
SYSTEM_NAME = f"ALGOFUND_MASTER::{API_KEY_NAME}::{SET_KEY}"
MAX_MEMBERS = int(os.environ.get("MRS2_PILOT_MAX_MEMBERS", "20"))
MAX_OPEN_POSITIONS = int(os.environ.get("MRS2_PILOT_OP", "16"))
LOT_PERCENT = float(os.environ.get("MRS2_PILOT_LOT", "6"))
REINVEST_PERCENT = float(os.environ.get("MRS2_PILOT_REINVEST", "100"))
STRATEGY_PREFIX = "MRS2_WEEX_PILOT"

# Confirmed missing on WEEX per weex_availability.json (mrs2 legs).
MISSING_SYMBOLS = {"BOBBOBUSDT", "BRUSDT", "CFGUSDT", "DEXEUSDT", "LITUSDT", "QUSDT"}
ALIAS_MAP = {
    "1000LUNCUSDT": "LUNCUSDT",
    "AMDSTOCKUSDT": "AMDUSDT",
    "LUNA2USDT": "LUNAUSDT",
    "PUMPFUNUSDT": "PUMPUSDT",
}


def load_mrs2_legs() -> list[dict]:
    rows = json.load(open(MAPPED, encoding="utf-8"))
    return [r for r in rows if str(r.get("strategy") or "").lower() == "mrs2"]


def load_weex_meta() -> dict[str, dict]:
    data = json.load(open(WEEX_AVAIL, encoding="utf-8"))
    return {str(row.get("symbol") or "").upper(): row for row in (data.get("symbols") or [])}


def safe_float(val, default: float = 0.0) -> float:
    try:
        return float(val)
    except (TypeError, ValueError):
        return default


def build_leg(row: dict, weex_meta: dict[str, dict]) -> dict | None:
    symbol = str(row["symbol"]).upper()
    if symbol in MISSING_SYMBOLS:
        return None
    meta = weex_meta.get(symbol) or {}
    if meta and meta.get("available") is False:
        return None
    weex_symbol = ALIAS_MAP.get(symbol, meta.get("weex_symbol") or symbol)
    leverage = safe_float(row.get("leverage"), 20.0)
    max_lev = meta.get("max_leverage")
    if max_lev:
        leverage = min(leverage, safe_float(max_lev, leverage))
    ma_len = int(safe_float(row.get("mrs_ma_len"), 5))
    return {
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
        "btWr": safe_float(row.get("bt_wr"), 0.0),
        "btTrades": int(safe_float(row.get("bt_trades"), 0)),
        "btPf": safe_float(row.get("bt_pf"), 1.0),
        "balPct": safe_float(row.get("bal_pct"), 0.0),
        "minOrderSize": meta.get("min_order_size"),
    }


def select_legs(legs: list[dict], limit: int) -> list[dict]:
    ranked = sorted(legs, key=lambda x: x["btPnl"], reverse=True)
    return ranked[:limit]


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


def ensure_api_key(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM api_keys WHERE name=?", (API_KEY_NAME,)).fetchone()
    if not row:
        raise SystemExit(f"api_key '{API_KEY_NAME}' not found in {DB} — create it first")
    return int(row[0])


def upsert_strategy(conn: sqlite3.Connection, api_key_id: int, leg: dict) -> int:
    name = strategy_name(leg)
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    cfg_json = mrs2_config_json(leg)
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET
                 strategy_type='MRS2', market_mode='mono', market_type='futures',
                 base_symbol=?, quote_symbol='', interval=?, leverage=?,
                 lot_long_percent=?, lot_short_percent=?, reinvest_percent=?,
                 mrs2_config_json=?, price_channel_length=?, zscore_entry=?, zscore_exit=?,
                 zscore_stop=?, take_profit_percent=0, detection_source='wick',
                 long_enabled=1, short_enabled=1, margin_type='cross',
                 updated_at=CURRENT_TIMESTAMP
               WHERE id=?""",
            (
                leg["weexSymbol"], leg["tf"], leg["leverage"],
                LOT_PERCENT, LOT_PERCENT, REINVEST_PERCENT,
                cfg_json, leg["mrsMaLen"], leg["mrsMultLong"], leg["mrsMultShort"],
                leg["mrsDist"], sid,
            ),
        )
        return sid
    conn.execute(
        """INSERT INTO strategies (
             name, api_key_id, strategy_type, market_mode, market_type, base_symbol, quote_symbol,
             interval, leverage, lot_long_percent, lot_short_percent, reinvest_percent,
             mrs2_config_json, price_channel_length, zscore_entry, zscore_exit, zscore_stop,
             take_profit_percent, detection_source, long_enabled, short_enabled, margin_type,
             is_active, display_on_chart, show_settings, show_chart, show_indicators,
             show_positions_on_chart, auto_update, fixed_lot, state
           ) VALUES (?, ?, 'MRS2', 'mono', 'futures', ?, '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
             0, 'wick', 1, 1, 'cross', 0, 1, 1, 1, 1, 1, 1, 0, 'flat')""",
        (
            name, api_key_id, leg["weexSymbol"], leg["tf"], leg["leverage"],
            LOT_PERCENT, LOT_PERCENT, REINVEST_PERCENT, cfg_json,
            leg["mrsMaLen"], leg["mrsMultLong"], leg["mrsMultShort"], leg["mrsDist"],
        ),
    )
    row = conn.execute(
        "SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, api_key_id)
    ).fetchone()
    return int(row[0])


def upsert_system(conn: sqlite3.Connection, api_key_id: int, member_ids: list[int]) -> int:
    row = conn.execute(
        "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (api_key_id, SYSTEM_NAME)
    ).fetchone()
    if row:
        sys_id = int(row[0])
        conn.execute(
            "UPDATE trading_systems SET max_members=?, max_open_positions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (max(MAX_MEMBERS, len(member_ids)), MAX_OPEN_POSITIONS, sys_id),
        )
    else:
        conn.execute(
            """INSERT INTO trading_systems (api_key_id, name, description, is_active, max_members, max_open_positions, market_type)
               VALUES (?, ?, ?, 0, ?, ?, 'futures')""",
            (
                api_key_id, SYSTEM_NAME,
                "MRS2-only WEEX pilot (OP16, lot6%, mono limit-touch entries).",
                max(MAX_MEMBERS, len(member_ids)), MAX_OPEN_POSITIONS,
            ),
        )
        row = conn.execute(
            "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (api_key_id, SYSTEM_NAME)
        ).fetchone()
        sys_id = int(row[0])

    conn.execute("UPDATE trading_system_members SET is_enabled=0 WHERE system_id=?", (sys_id,))
    for sid in member_ids:
        conn.execute(
            """INSERT INTO trading_system_members (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, 'core', 1, 'mrs2_weex_pilot')
               ON CONFLICT(system_id, strategy_id) DO UPDATE SET
                 weight=excluded.weight, is_enabled=1, notes=excluded.notes""",
            (sys_id, sid, round(1.0 / max(1, len(member_ids)), 6)),
        )
    return sys_id


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="write strategies + trading system to DB")
    parser.add_argument("--limit", type=int, default=MAX_MEMBERS)
    args = parser.parse_args()

    legs_raw = load_mrs2_legs()
    weex_meta = load_weex_meta()
    legs: list[dict] = []
    dropped: list[str] = []
    for r in legs_raw:
        leg = build_leg(r, weex_meta)
        if leg is None:
            dropped.append(str(r["symbol"]).upper())
            continue
        legs.append(leg)

    picked = select_legs(legs, args.limit)

    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "setKey": SET_KEY,
        "systemName": SYSTEM_NAME,
        "apiKeyName": API_KEY_NAME,
        "portfolio": {
            "lotPercent": LOT_PERCENT,
            "reinvestPercent": REINVEST_PERCENT,
            "maxOpenPositions": MAX_OPEN_POSITIONS,
        },
        "legsConsideredTotal": len(legs_raw),
        "legsAvailableOnWeex": len(legs),
        "legsDropped": sorted(dropped),
        "legsPicked": len(picked),
        "members": picked,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(card, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"Wrote {OUT}")
    print(f"MRS2 legs total={len(legs_raw)} weex-available={len(legs)} dropped={sorted(dropped)}")
    print(f"Picked {len(picked)} legs for {SYSTEM_NAME} (OP{MAX_OPEN_POSITIONS}, lot{LOT_PERCENT}%):")
    for leg in picked:
        alias_note = f" (alias of {leg['hamsterSymbol']})" if leg["aliased"] else ""
        print(
            f"  {leg['weexSymbol']:14}{alias_note:24} tf={leg['tf']:4} lev={leg['leverage']:.0f}x "
            f"btPnl={leg['btPnl']:.1f} btPf={leg['btPf']:.2f} btWr={leg['btWr']:.1f}%"
        )

    if not args.apply:
        print("\nDry-run only (no DB writes). Pass --apply to create/update strategies + trading system.")
        return

    if not os.path.isfile(DB):
        raise SystemExit(f"DB not found: {DB}")
    conn = sqlite3.connect(DB)
    try:
        api_key_id = ensure_api_key(conn)
        member_ids: list[int] = []
        for leg in picked:
            sid = upsert_strategy(conn, api_key_id, leg)
            member_ids.append(sid)
        sys_id = upsert_system(conn, api_key_id, member_ids)
        conn.commit()
    finally:
        conn.close()

    card["memberStrategyIds"] = member_ids
    card["systemId"] = sys_id
    json.dump(card, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"\nApplied: system_id={sys_id} ({SYSTEM_NAME}), {len(member_ids)} strategies (is_active=0, paused).")
    print("Strategies created paused. Activate deliberately (per-strategy is_active=1) before live trading.")


if __name__ == "__main__":
    main()

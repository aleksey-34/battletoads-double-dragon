#!/usr/bin/env python3
"""Publish WEEX stocks short-MA sleeve TS and attach to all portfolios."""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SLEEVE = os.path.join(os.path.dirname(__file__), "portfolio_six_data_jul2026", "stock_sleeve_shortma.json")
DB = os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE") or os.path.join(REPO, "backend", "database.db")
MASTER = os.environ.get("MASTER_API_KEY", "BTDD_D1")
SYSTEM = f"ALGOFUND_MASTER::{MASTER}::addon-mrs-weex-stocks-shortma-jul2026"
OP = int(os.environ.get("STOCK_OP", "6"))
LOT = float(os.environ.get("STOCK_LOT", "15"))
WEIGHT = float(os.environ.get("STOCK_WEIGHT", "0.5"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--sleeve", default=SLEEVE)
    args = ap.parse_args()
    if not args.run:
        raise SystemExit("pass --run")

    doc = json.load(open(args.sleeve, encoding="utf-8"))
    legs = doc["legs"]
    ts = now()
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    ak = conn.execute("SELECT id FROM api_keys WHERE name=?", (MASTER,)).fetchone()
    if not ak:
        raise SystemExit(f"master key {MASTER} missing in {DB}")
    ak_id = int(ak["id"])

    sids: list[int] = []
    for leg in legs:
        p = leg["params"]
        name = f"PF6::STOCK::SHORTMA::{leg['symbol']}::{leg['tf']}"
        mrs2 = json.dumps(
            {
                "maLongLen": p["maLongLen"],
                "maLongMult": p["maLongMult"],
                "maShortLen": p["maShortLen"],
                "maShortMult": p["maShortMult"],
                "maCloseLongLen": p.get("maCloseLongLen", p["maLongLen"]),
                "maCloseLongMult": p.get("maCloseLongMult", 1),
                "maCloseShortLen": p.get("maCloseShortLen", p["maShortLen"]),
                "maCloseShortMult": p.get("maCloseShortMult", 1),
                "distanceFilterPct": p.get("distanceFilterPct", 0.05),
                "slLongPct": 0,
                "slShortPct": 0,
            },
            ensure_ascii=False,
        )
        row = conn.execute(
            "SELECT id FROM strategies WHERE api_key_id=? AND name=?", (ak_id, name)
        ).fetchone()
        if row:
            sid = int(row["id"])
            conn.execute(
                """UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
                   price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
                   mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
                   reinvest_percent=100, market_mode='mono', market_type='futures',
                   is_archived=0, updated_at=? WHERE id=?""",
                (
                    leg["symbol"],
                    leg["tf"],
                    p["maLongLen"],
                    p["maLongMult"],
                    p["maShortMult"],
                    p.get("distanceFilterPct", 0.05),
                    mrs2,
                    LOT,
                    LOT,
                    ts,
                    sid,
                ),
            )
        else:
            cur = conn.execute(
                """INSERT INTO strategies (
                     name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
                     price_channel_length, detection_source, take_profit_percent,
                     zscore_entry, zscore_exit, zscore_stop,
                     long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
                     reinvest_percent, max_deposit, market_mode, market_type, mrs2_config_json,
                     is_active, is_archived, is_runtime, origin, created_at, updated_at
                   ) VALUES (?,?, 'MeanReversion', ?, '', ?, ?, 'wick', 0, ?,?,?,1,1,20,?,?,100,500000,'mono','futures',?,0,0,0,'research',?,?)""",
                (
                    name,
                    ak_id,
                    leg["symbol"],
                    leg["tf"],
                    p["maLongLen"],
                    p["maLongMult"],
                    p["maShortMult"],
                    p.get("distanceFilterPct", 0.05),
                    LOT,
                    LOT,
                    mrs2,
                    ts,
                    ts,
                ),
            )
            sid = int(cur.lastrowid)
        sids.append(sid)
    print(f"strategies={len(sids)} {sids}")

    desc = f"WEEX stocks short-MA sleeve OP{OP} lot{LOT}"
    row = conn.execute(
        "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (ak_id, SYSTEM)
    ).fetchone()
    if row:
        system_id = int(row["id"])
        conn.execute(
            "UPDATE trading_systems SET max_open_positions=?, description=?, is_active=1, updated_at=? WHERE id=?",
            (OP, desc, ts, system_id),
        )
    else:
        cur = conn.execute(
            """INSERT INTO trading_systems (
                 api_key_id, name, description, max_open_positions, is_active, created_at, updated_at
               ) VALUES (?,?,?,?,1,?,?)""",
            (ak_id, SYSTEM, desc, OP, ts, ts),
        )
        system_id = int(cur.lastrowid)

    conn.execute("DELETE FROM trading_system_members WHERE system_id=?", (system_id,))
    for sid in sids:
        conn.execute(
            """INSERT INTO trading_system_members (
                 system_id, strategy_id, weight, is_enabled, member_role, created_at
               ) VALUES (?,?,1,1,'addon',?)""",
            (system_id, sid, ts),
        )

    meta = {
        "displayLabel": "WEEX Stocks short-MA",
        "lotPercentOverride": LOT,
        "reinvestPercentOverride": 100,
        "maxOpenPositions": OP,
        "role": "stocks_addon",
        "universe": "weex_stocks_shortma",
        "bookMetrics": doc.get("book"),
        "legs": legs,
    }
    code = f"CARD::{SYSTEM.upper()}"
    conn.execute(
        """INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
           VALUES (?,?,?,?,1,?,?,?)
           ON CONFLICT(code) DO UPDATE SET
             name=excluded.name, description=excluded.description,
             source_system_id=excluded.source_system_id, is_active=1,
             metadata_json=excluded.metadata_json, updated_at=excluded.updated_at""",
        (code, desc, desc, system_id, json.dumps(meta, ensure_ascii=False), ts, ts),
    )

    ports = conn.execute("SELECT id, set_key FROM algofund_portfolios WHERE is_enabled=1").fetchall()
    for pf in ports:
        ex = conn.execute(
            "SELECT id FROM algofund_portfolio_members WHERE portfolio_id=? AND system_name=?",
            (pf["id"], SYSTEM),
        ).fetchone()
        if ex:
            conn.execute(
                "UPDATE algofund_portfolio_members SET role='stocks', capital_weight=?, is_enabled=1, updated_at=? WHERE id=?",
                (WEIGHT, ts, ex["id"]),
            )
        else:
            m = conn.execute(
                "SELECT COALESCE(MAX(sort_order),-1) AS m FROM algofund_portfolio_members WHERE portfolio_id=?",
                (pf["id"],),
            ).fetchone()["m"]
            conn.execute(
                """INSERT INTO algofund_portfolio_members (
                     portfolio_id, system_name, role, capital_weight, sort_order, is_enabled, created_at, updated_at
                   ) VALUES (?,?,?,?,?,1,?,?)""",
                (pf["id"], SYSTEM, "stocks", WEIGHT, int(m) + 1, ts, ts),
            )
        print(f"attached {pf['set_key']} weight={WEIGHT}")

    conn.commit()
    print(f"DONE system_id={system_id} members={len(sids)} portfolios={len(ports)}")
    conn.close()


if __name__ == "__main__":
    main()

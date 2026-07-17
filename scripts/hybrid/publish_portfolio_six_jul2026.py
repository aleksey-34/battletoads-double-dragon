#!/usr/bin/env python3
"""
Publish 6 Algofund portfolios (shared B3 + MRS WF packs ± ZZ) into a DB.

Works locally (flat_comp) and on VPS production DB. Creates:
  - PF6::MRS::N{n}::* strategies from scripts/hybrid/data/portfolio_six_jul2026/mrs_wf_top30.json
  - PF6::ZZ::* strategies from recipe universe
  - ALGOFUND_MASTER::BTDD_D1::* trading systems + master_cards metadata
  - algofund_portfolios / algofund_portfolio_members with stamped BT snapshots

Does NOT mutate live B3 system 205 membership — only reads its strategy ids.

  BTDD_DB_PATH=backend/database.db.flat_comp python3 scripts/hybrid/publish_portfolio_six_jul2026.py --run
  BTDD_DB_PATH=/opt/battletoads-double-dragon/backend/database.db \\
    B3_SYSTEM_ID=205 python3 scripts/hybrid/publish_portfolio_six_jul2026.py --run
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(os.path.dirname(__file__), "portfolio_six_data_jul2026")
DB = os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE") or os.path.join(REPO, "backend", "database.db.flat_comp")
MASTER = os.environ.get("MASTER_API_KEY", "BTDD_D1")
B3_ID = int(os.environ.get("B3_SYSTEM_ID", "205"))


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_json(path: str):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def ensure_schema(conn: sqlite3.Connection) -> None:
    conn.executescript(
        """
        CREATE TABLE IF NOT EXISTS algofund_portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          set_key TEXT NOT NULL UNIQUE,
          display_label TEXT NOT NULL,
          description TEXT DEFAULT '',
          is_storefront BOOLEAN DEFAULT 1,
          is_personal BOOLEAN DEFAULT 0,
          metadata_json TEXT DEFAULT '{}',
          snapshot_json TEXT DEFAULT '{}',
          is_enabled BOOLEAN DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        );
        CREATE TABLE IF NOT EXISTS algofund_portfolio_members (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          portfolio_id INTEGER NOT NULL,
          system_name TEXT NOT NULL,
          role TEXT DEFAULT 'addon',
          capital_weight REAL DEFAULT 1.0,
          sort_order INTEGER DEFAULT 0,
          is_enabled BOOLEAN DEFAULT 1,
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (portfolio_id, system_name)
        );
        CREATE TABLE IF NOT EXISTS algofund_active_portfolios (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL,
          portfolio_id INTEGER NOT NULL,
          is_enabled BOOLEAN DEFAULT 1,
          assigned_by TEXT DEFAULT 'admin',
          created_at TEXT DEFAULT CURRENT_TIMESTAMP,
          updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
          UNIQUE (profile_id, portfolio_id)
        );
        """
    )


def api_key_id(conn: sqlite3.Connection) -> int:
    row = conn.execute("SELECT id FROM api_keys WHERE name=?", (MASTER,)).fetchone()
    if not row:
        raise SystemExit(f"api key {MASTER} missing")
    return int(row[0])


def upsert_mrs(conn: sqlite3.Connection, ak: int, leg: dict, tag: str) -> int:
    symbol = str(leg["symbol"])
    tf = str(leg["tf"])
    name = f"PF6::MRS::{tag}::{symbol}::{tf}"
    p = leg.get("params") or {}
    lot = 6.0
    mrs2 = json.dumps(
        {
            "maLongLen": p.get("maLongLen", 5),
            "maLongMult": p.get("maLongMult", 0.95),
            "maShortLen": p.get("maShortLen", 5),
            "maShortMult": p.get("maShortMult", 1.05),
            "maCloseLongLen": p.get("maCloseLongLen", 5),
            "maCloseLongMult": p.get("maCloseLongMult", 1),
            "maCloseShortLen": p.get("maCloseShortLen", 5),
            "maCloseShortMult": p.get("maCloseShortMult", 1),
            "distanceFilterPct": p.get("distanceFilterPct", 0.3),
            "slLongPct": p.get("slLongPct", 0),
            "slShortPct": 0,
        },
        ensure_ascii=False,
    )
    row = conn.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND name=?", (ak, name)
    ).fetchone()
    ma_long_len = float(p.get("maLongLen") or 5)
    ma_long_mult = float(p.get("maLongMult") or 0.95)
    ma_short_mult = float(p.get("maShortMult") or 1.05)
    dist = float(p.get("distanceFilterPct") or 0.3)
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET strategy_type='MeanReversion', base_symbol=?, interval=?,
               price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
               mrs2_config_json=?, leverage=20, lot_long_percent=?, lot_short_percent=?,
               reinvest_percent=100, market_mode='mono', market_type='futures',
               is_archived=0, updated_at=? WHERE id=?""",
            (symbol, tf, ma_long_len, ma_long_mult, ma_short_mult, dist, mrs2, lot, lot, now(), sid),
        )
        return sid
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
            name, ak, symbol, tf, ma_long_len, ma_long_mult, ma_short_mult, dist,
            lot, lot, mrs2, now(), now(),
        ),
    )
    return int(cur.lastrowid)


def upsert_zz(conn: sqlite3.Connection, ak: int, leg: dict) -> int:
    symbol = str(leg["symbol"])
    tf = str(leg["tf"])
    stype = str(leg.get("type") or "ZZ_Fast")
    length = int(leg.get("length") or 2)
    name = f"PF6::ZZ::{stype}::{symbol}::{tf}::L{length}"
    row = conn.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND name=?", (ak, name)
    ).fetchone()
    lot = 6.0
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET strategy_type=?, base_symbol=?, interval=?,
               price_channel_length=?, lot_long_percent=?, lot_short_percent=?,
               reinvest_percent=100, market_mode='mono', market_type='futures',
               is_archived=0, updated_at=? WHERE id=?""",
            (stype, symbol, tf, length, lot, lot, now(), sid),
        )
        return sid
    cur = conn.execute(
        """INSERT INTO strategies (
             name, api_key_id, strategy_type, base_symbol, quote_symbol, interval,
             price_channel_length, detection_source, take_profit_percent,
             long_enabled, short_enabled, leverage, lot_long_percent, lot_short_percent,
             reinvest_percent, max_deposit, market_mode, market_type,
             is_active, is_archived, is_runtime, origin, created_at, updated_at
           ) VALUES (?,?,?,?, '', ?, ?, 'wick', 0, 1,1,20,?,?,100,500000,'mono','futures',0,0,0,'research',?,?)""",
        (name, ak, stype, symbol, tf, length, lot, lot, now(), now()),
    )
    return int(cur.lastrowid)


def upsert_ts(conn: sqlite3.Connection, name: str, ak: int, mop: int, meta: dict) -> int:
    row = conn.execute(
        "SELECT id FROM trading_systems WHERE api_key_id=? AND name=?", (ak, name)
    ).fetchone()
    desc = str(meta.get("displayLabel") or name)[:200]
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE trading_systems SET max_open_positions=?, description=?,
               is_active=1, updated_at=? WHERE id=?""",
            (mop, desc, now(), sid),
        )
    else:
        cur = conn.execute(
            """INSERT INTO trading_systems (
                 api_key_id, name, description, max_open_positions, is_active, created_at, updated_at
               ) VALUES (?,?,?,?,1,?,?)""",
            (ak, name, desc, mop, now(), now()),
        )
        sid = int(cur.lastrowid)
    code = f"CARD::{name.upper()}"
    meta_s = json.dumps({**meta, "maxOpenPositions": mop}, ensure_ascii=False)
    conn.execute(
        """INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
           VALUES (?,?,?,?,1,?,?,?)
           ON CONFLICT(code) DO UPDATE SET
             name=excluded.name, description=excluded.description,
             source_system_id=excluded.source_system_id, is_active=1,
             metadata_json=excluded.metadata_json, updated_at=excluded.updated_at""",
        (code, desc, desc, sid, meta_s, now(), now()),
    )
    return sid


def replace_members(conn: sqlite3.Connection, system_id: int, strategy_ids: list[int], role: str) -> None:
    conn.execute("DELETE FROM trading_system_members WHERE system_id=?", (system_id,))
    for sid in strategy_ids:
        conn.execute(
            """INSERT INTO trading_system_members (
                 system_id, strategy_id, weight, is_enabled, member_role, created_at
               ) VALUES (?,?,1,1,?,?)""",
            (system_id, sid, role, now()),
        )


def b3_strategy_ids(conn: sqlite3.Connection) -> list[int]:
    rows = conn.execute(
        """SELECT s.id FROM trading_system_members m
           JOIN strategies s ON s.id=m.strategy_id
           WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1 ORDER BY s.id""",
        (B3_ID,),
    ).fetchall()
    return [int(r[0]) for r in rows]


def upsert_portfolio(
    conn: sqlite3.Connection,
    set_key: str,
    label: str,
    description: str,
    storefront: bool,
    personal: bool,
    meta: dict,
    snap: dict,
    members: list[dict],
) -> int:
    row = conn.execute("SELECT id FROM algofund_portfolios WHERE set_key=?", (set_key,)).fetchone()
    meta_s = json.dumps(meta, ensure_ascii=False)
    snap_s = json.dumps(snap, ensure_ascii=False)
    if row:
        pid = int(row[0])
        conn.execute(
            """UPDATE algofund_portfolios SET display_label=?, description=?, is_storefront=?, is_personal=?,
               metadata_json=?, snapshot_json=?, is_enabled=1, updated_at=? WHERE id=?""",
            (label, description, 1 if storefront else 0, 1 if personal else 0, meta_s, snap_s, now(), pid),
        )
    else:
        cur = conn.execute(
            """INSERT INTO algofund_portfolios (
                 set_key, display_label, description, is_storefront, is_personal,
                 metadata_json, snapshot_json, is_enabled, created_at, updated_at
               ) VALUES (?,?,?,?,?,?,?,1,?,?)""",
            (set_key, label, description, 1 if storefront else 0, 1 if personal else 0, meta_s, snap_s, now(), now()),
        )
        pid = int(cur.lastrowid)
    conn.execute("DELETE FROM algofund_portfolio_members WHERE portfolio_id=?", (pid,))
    for i, m in enumerate(members):
        conn.execute(
            """INSERT INTO algofund_portfolio_members (
                 portfolio_id, system_name, role, capital_weight, sort_order, is_enabled, created_at, updated_at
               ) VALUES (?,?,?,?,?,1,?,?)""",
            (pid, m["system_name"], m["role"], m.get("weight", 1.0), i, now(), now()),
        )
    return pid


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.run and not args.dry_run:
        raise SystemExit("pass --run or --dry-run")

    recipes = load_json(os.path.join(DATA, "recipes.json"))
    mrs_pack = load_json(os.path.join(DATA, "mrs_wf_top30.json"))
    snaps = load_json(os.path.join(DATA, "snapshots_card_full.json"))
    legs = mrs_pack.get("legs") or []
    if len(legs) < 20:
        raise SystemExit(f"mrs legs too few: {len(legs)}")

    print(f"DB={DB} MASTER={MASTER} B3_ID={B3_ID} legs={len(legs)}")
    if args.dry_run:
        print("dry-run portfolios", [p["setKey"] for p in recipes["portfolios"]])
        return

    conn = sqlite3.connect(DB)
    ensure_schema(conn)
    ak = api_key_id(conn)
    b3_ids = b3_strategy_ids(conn)
    if len(b3_ids) < 10:
        raise SystemExit(f"B3 system {B3_ID} has only {len(b3_ids)} members")
    print(f"B3 members={len(b3_ids)}")

    # Upsert MRS strategy pools N20/N25/N30 (prefix slices of durable cloud)
    mrs_ids_by_n: dict[int, list[int]] = {}
    for n in (20, 25, 30):
        ids = [upsert_mrs(conn, ak, leg, f"N{n}") for leg in legs[:n]]
        mrs_ids_by_n[n] = ids
        print(f"MRS N{n} strategies={len(ids)}")

    zz_legs = (recipes.get("universes") or {}).get("ham_zz_top5_weex", {}).get("legs") or []
    zz_ids = [upsert_zz(conn, ak, z) for z in zz_legs]
    print(f"ZZ strategies={len(zz_ids)}")

    b3_name = f"ALGOFUND_MASTER::{MASTER}::{recipes['sharedB3']['setKey']}"
    addon_names = {
        20: f"ALGOFUND_MASTER::{MASTER}::addon-mrs-wf-top20-jul2026",
        25: f"ALGOFUND_MASTER::{MASTER}::addon-mrs-wf-top25-jul2026",
        30: f"ALGOFUND_MASTER::{MASTER}::addon-mrs-wf-top30-jul2026",
    }
    zz_name = f"ALGOFUND_MASTER::{MASTER}::addon-zz-top5-jul2026"

    b3_sid = upsert_ts(
        conn,
        b3_name,
        ak,
        int(recipes["sharedB3"]["op"]),
        {
            "displayLabel": "B3 Core (shared)",
            "lotPercentOverride": recipes["sharedB3"]["lot"],
            "reinvestPercentOverride": recipes["sharedB3"]["ri"],
            "maxOpenPositions": recipes["sharedB3"]["op"],
            "role": "b3_core",
            "tierCbOnZzBreakout": True,
        },
    )
    replace_members(conn, b3_sid, b3_ids, "core")
    print(f"B3 TS id={b3_sid}")

    addon_ts: dict[int, dict] = {}
    defaults = {20: (16, 6), 25: (14, 7), 30: (16, 6)}
    for n, name in addon_names.items():
        op, lot = defaults[n]
        sid = upsert_ts(
            conn,
            name,
            ak,
            op,
            {
                "displayLabel": f"MRS WF top{n}",
                "lotPercentOverride": lot,
                "reinvestPercentOverride": 100,
                "maxOpenPositions": op,
                "role": "mrs_addon",
                "universe": f"mrs_wf_top{n}",
            },
        )
        replace_members(conn, sid, mrs_ids_by_n[n], "addon")
        addon_ts[n] = {"id": sid, "name": name, "n": len(mrs_ids_by_n[n]), "op": op, "lot": lot}
        print(f"MRS top{n} TS id={sid}")

    def mrs_clone(n: int, op: int, lot: int, tag: str) -> dict:
        name = f"ALGOFUND_MASTER::{MASTER}::addon-mrs-wf-top{n}-op{op}-lot{lot}-{tag}-jul2026"
        sid = upsert_ts(
            conn,
            name,
            ak,
            op,
            {
                "displayLabel": f"MRS WF top{n} OP{op} lot{lot}",
                "lotPercentOverride": lot,
                "reinvestPercentOverride": 100,
                "maxOpenPositions": op,
                "role": "mrs_addon",
                "universe": f"mrs_wf_top{n}",
            },
        )
        replace_members(conn, sid, mrs_ids_by_n[n], "addon")
        print(f"MRS clone {tag} id={sid} OP{op} lot{lot}")
        return {"id": sid, "name": name, "n": len(mrs_ids_by_n[n]), "op": op, "lot": lot}

    addon_by_pf = {
        "P3": mrs_clone(30, 20, 8, "p3"),
        "P6": mrs_clone(30, 20, 10, "p6"),
    }

    zz_sid = upsert_ts(
        conn,
        zz_name,
        ak,
        8,
        {
            "displayLabel": "ZigZag top5",
            "lotPercentOverride": 6,
            "reinvestPercentOverride": 100,
            "maxOpenPositions": 8,
            "role": "zz_addon",
        },
    )
    replace_members(conn, zz_sid, zz_ids, "addon")
    print(f"ZZ TS id={zz_sid} n={len(zz_ids)}")

    universe_map = {
        "mrs_wf_top20": 20,
        "mrs_wf_top25": 25,
        "mrs_wf_top30": 30,
        "mrs_wf_all_durable": 30,
    }

    published = []
    for pf in recipes["portfolios"]:
        members = []
        for book in pf["books"]:
            if book["key"] == "b3":
                members.append(
                    {
                        "system_name": b3_name,
                        "role": "b3",
                        "weight": book["initial"] / 10000.0,
                    }
                )
            elif book["key"] == "mrs":
                n = universe_map[book["universe"]]
                pack = addon_by_pf.get(pf["id"]) or addon_ts[n]
                members.append(
                    {
                        "system_name": pack["name"],
                        "role": "mrs",
                        "weight": book["initial"] / 10000.0,
                        "op": book.get("op") or pack.get("op"),
                        "lot": book.get("lot") or pack.get("lot"),
                    }
                )
            elif book["key"] == "zz":
                members.append(
                    {
                        "system_name": zz_name,
                        "role": "zz",
                        "weight": book["initial"] / 10000.0,
                    }
                )
        snap = dict(snaps.get(pf["id"]) or {})
        # Enrich books metadata for UI modal
        meta_books = []
        for book in pf["books"]:
            b = dict(book)
            if book["key"] == "b3":
                b.update({"op": recipes["sharedB3"]["op"], "lot": recipes["sharedB3"]["lot"]})
            meta_books.append(b)
        meta = {"books": meta_books, "bt": {k: snap.get(k) for k in ("ret", "dd", "capital", "method")}}
        desc = str(pf.get("description") or pf.get("retune") or f"{pf['label']}: shared B3 + addon TS")
        pid = upsert_portfolio(
            conn,
            pf["setKey"],
            pf["label"],
            desc,
            pf.get("storefront", True),
            pf.get("personal", False),
            meta,
            snap,
            members,
        )
        published.append({"id": pf["id"], "portfolioId": pid, "setKey": pf["setKey"], "members": members})
        print(f"Portfolio {pf['id']} id={pid} members={len(members)} ret={snap.get('ret')} dd={snap.get('dd')}")

    conn.commit()
    out_path = os.path.join(DATA, "last_publish.json")
    json.dump(
        {"generatedAt": now(), "db": DB, "b3": b3_name, "addons": addon_ts, "zz": zz_name, "portfolios": published},
        open(out_path, "w"),
        indent=2,
    )
    print(f"Wrote {out_path}")
    conn.close()


if __name__ == "__main__":
    main()

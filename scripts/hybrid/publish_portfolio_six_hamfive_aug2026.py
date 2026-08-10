#!/usr/bin/env python3
"""
Publish six Algofund portfolios: shared B3 + HAM ZZ + FIVECARD thin + stocks ZZ.

Keeps live set_keys (portfolio-*-jul2026). Replaces fat MRS / stock-MRS books.
Creates PF6::HAM::* / PF6::FIVE::* / PF6::STOCKSZZ::* strategy clones from
hamfive_legs_aug2026.json so VPS does not need research source ids.

  BTDD_DB_PATH=backend/database.db.flat_comp python3 scripts/hybrid/publish_portfolio_six_hamfive_aug2026.py --dry-run
  BTDD_DB_PATH=/opt/battletoads-double-dragon/backend/database.db \\
    B3_SYSTEM_ID=205 python3 scripts/hybrid/publish_portfolio_six_hamfive_aug2026.py --run
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DATA = os.path.join(os.path.dirname(__file__), "portfolio_six_data_jul2026")
DB = os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE") or os.path.join(REPO, "backend", "database.db")
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


def upsert_leg(conn: sqlite3.Connection, ak: int, leg: dict, name: str) -> int:
    stype = str(leg.get("strategy_type") or "ZZ_Fast")
    symbol = str(leg["base_symbol"])
    quote = str(leg.get("quote_symbol") or "")
    tf = str(leg["interval"])
    length = int(leg.get("price_channel_length") or 2)
    z_in = float(leg.get("zscore_entry") or 2)
    z_out = float(leg.get("zscore_exit") or 0.5)
    z_stop = float(leg.get("zscore_stop") or 3.5)
    mrs2 = leg.get("mrs2_config_json") or "{}"
    if isinstance(mrs2, dict):
        mrs2 = json.dumps(mrs2, ensure_ascii=False)
    lot = float(leg.get("lot_long_percent") or 6)
    lev = float(leg.get("leverage") or 20)
    tp = float(leg.get("take_profit_percent") or 0)
    det = str(leg.get("detection_source") or "wick")
    mode = str(leg.get("market_mode") or "mono")
    mtype = str(leg.get("market_type") or "futures")
    row = conn.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND name=?", (ak, name)
    ).fetchone()
    if row:
        sid = int(row[0])
        conn.execute(
            """UPDATE strategies SET strategy_type=?, base_symbol=?, quote_symbol=?, interval=?,
               price_channel_length=?, zscore_entry=?, zscore_exit=?, zscore_stop=?,
               mrs2_config_json=?, leverage=?, lot_long_percent=?, lot_short_percent=?,
               take_profit_percent=?, detection_source=?, reinvest_percent=100,
               market_mode=?, market_type=?, is_archived=0, updated_at=? WHERE id=?""",
            (
                stype, symbol, quote, tf, length, z_in, z_out, z_stop, mrs2, lev,
                lot, lot, tp, det, mode, mtype, now(), sid,
            ),
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
           ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,1,1,?,?,?,100,500000,?,?,?,0,0,0,'research',?,?)""",
        (
            name, ak, stype, symbol, quote, tf, length, det, tp,
            z_in, z_out, z_stop, lev, lot, lot, mode, mtype, mrs2, now(), now(),
        ),
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
    ids = [int(r[0]) for r in rows]
    if ids:
        conn.execute(
            f"UPDATE strategies SET is_archived=0, updated_at=? WHERE id IN ({','.join('?' for _ in ids)}) AND COALESCE(is_archived,0)=1",
            (now(), *ids),
        )
    return ids


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


def leg_name(kind: str, leg: dict) -> str:
    sym = leg["base_symbol"]
    tf = leg["interval"]
    stype = leg.get("strategy_type") or "ZZ"
    length = int(leg.get("price_channel_length") or 0)
    if kind == "ham":
        return f"PF6::HAM::{stype}::{sym}::{tf}::L{length}"
    if kind == "five":
        # keep set suffix if present in source name
        src = str(leg.get("name") or "")
        set_tag = src.split("::")[-1] if "set_" in src else "set"
        return f"PF6::FIVE::MRS2::{sym}::{tf}::{set_tag}"
    if kind == "stocks":
        return f"PF6::STOCKSZZ::{stype}::{sym}::{tf}::L{length}"
    raise ValueError(kind)


def resolve_universe_legs(universes: dict, legs_doc: dict, key: str) -> list[dict]:
    u = universes.get(key) or {}
    src = str(u.get("from") or "")
    pool = legs_doc.get(src) or []
    by_id = {int(x["id"]): x for x in pool if "id" in x}
    ids = u.get("ids")
    if ids:
        out = []
        for i in ids:
            leg = by_id.get(int(i))
            if not leg:
                raise SystemExit(f"universe {key}: missing leg id {i} in {src}")
            out.append(leg)
        return out
    if src == "stocks":
        want = set(u.get("apiSymbols") or [])
        if want:
            return [x for x in pool if x.get("base_symbol") in want]
        return list(pool)
    raise SystemExit(f"universe {key}: no ids and not stocks")


def retire_old_masters(conn: sqlite3.Connection, prefixes: list[str], keep_names: set[str]) -> dict:
    """Soft-disable old MRS/ZZ/stock-MRS masters that are no longer portfolio members."""
    retired_ts = []
    for pref in prefixes:
        rows = conn.execute(
            "SELECT id, name FROM trading_systems WHERE name LIKE ?",
            (f"{pref}%",),
        ).fetchall()
        for rid, name in rows:
            if name in keep_names:
                continue
            conn.execute(
                "UPDATE trading_systems SET is_active=0, updated_at=? WHERE id=?",
                (now(), int(rid)),
            )
            conn.execute(
                """UPDATE master_cards SET is_active=0, updated_at=?
                   WHERE source_system_id=? OR code=?""",
                (now(), int(rid), f"CARD::{name.upper()}"),
            )
            retired_ts.append(name)

    # Archive orphan PF6 MRS / SHORTMA strategies not attached to any active TS
    archived = 0
    for like in ("PF6::MRS::%", "PF6::STOCK::SHORTMA::%"):
        rows = conn.execute(
            """SELECT s.id FROM strategies s
               WHERE s.name LIKE ? AND COALESCE(s.is_archived,0)=0
                 AND NOT EXISTS (
                   SELECT 1 FROM trading_system_members m
                   JOIN trading_systems ts ON ts.id=m.system_id
                   WHERE m.strategy_id=s.id AND COALESCE(ts.is_active,1)=1
                 )""",
            (like,),
        ).fetchall()
        for (sid,) in rows:
            conn.execute(
                "UPDATE strategies SET is_archived=1, is_active=0, updated_at=? WHERE id=?",
                (now(), int(sid)),
            )
            archived += 1
    return {"retiredTs": retired_ts, "archivedStrategies": archived}


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--skip-retire", action="store_true")
    args = ap.parse_args()
    if not args.run and not args.dry_run:
        raise SystemExit("pass --run or --dry-run")

    recipes = load_json(os.path.join(DATA, "recipes_hamfive_aug2026.json"))
    legs_doc = load_json(os.path.join(DATA, "hamfive_legs_aug2026.json"))
    snaps = load_json(os.path.join(DATA, "snapshots_hamfive_aug2026.json"))
    universes = recipes.get("universes") or {}

    print(f"DB={DB} MASTER={MASTER} B3_ID={B3_ID}")
    if args.dry_run:
        for pf in recipes["portfolios"]:
            books = [f"{b['key']}:{b.get('universe') or 'shared'} op={b.get('op')} lot={b.get('lot')}" for b in pf["books"]]
            print(f"  {pf['id']} {pf['setKey']} :: {books}")
        return

    conn = sqlite3.connect(DB)
    ensure_schema(conn)
    ak = api_key_id(conn)
    b3_ids = b3_strategy_ids(conn)
    if len(b3_ids) < 10:
        raise SystemExit(f"B3 system {B3_ID} has only {len(b3_ids)} members")
    print(f"B3 members={len(b3_ids)}")

    # Clone all legs once
    ham_ids: dict[int, int] = {}
    for leg in legs_doc.get("ham") or []:
        sid = upsert_leg(conn, ak, leg, leg_name("ham", leg))
        ham_ids[int(leg["id"])] = sid
    five_ids: dict[int, int] = {}
    for leg in legs_doc.get("five") or []:
        sid = upsert_leg(conn, ak, leg, leg_name("five", leg))
        five_ids[int(leg["id"])] = sid
    stock_ids: dict[str, int] = {}
    for leg in legs_doc.get("stocks") or []:
        sid = upsert_leg(conn, ak, leg, leg_name("stocks", leg))
        stock_ids[str(leg["base_symbol"])] = sid
    print(f"cloned HAM={len(ham_ids)} FIVE={len(five_ids)} STOCKS={len(stock_ids)}")

    def ids_for_universe(key: str) -> list[int]:
        ulegs = resolve_universe_legs(universes, legs_doc, key)
        src = (universes.get(key) or {}).get("from")
        out = []
        for leg in ulegs:
            if src == "ham":
                out.append(ham_ids[int(leg["id"])])
            elif src == "five":
                out.append(five_ids[int(leg["id"])])
            elif src == "stocks":
                out.append(stock_ids[str(leg["base_symbol"])])
        return out

    b3_name = f"ALGOFUND_MASTER::{MASTER}::{recipes['sharedB3']['setKey']}"
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
            "pack": "hamfive_aug2026",
        },
    )
    replace_members(conn, b3_sid, b3_ids, "core")
    print(f"B3 TS id={b3_sid}")

    # Unique addon TS by tsTag
    addon_ts: dict[str, dict] = {}
    keep_names: set[str] = {b3_name}

    for pf in recipes["portfolios"]:
        for book in pf["books"]:
            if book["key"] == "b3":
                continue
            tag = str(book["tsTag"])
            if tag in addon_ts:
                continue
            uni = book["universe"]
            sids = ids_for_universe(uni)
            if not sids:
                raise SystemExit(f"empty universe {uni} for {tag}")
            name = f"ALGOFUND_MASTER::{MASTER}::addon-{tag}"
            role = book["key"]
            label_map = {
                "ham": "HAM ZZ flat+",
                "five": "FIVECARD thin MR",
                "stocks": "WEEX stocks ZZ 4h L30",
            }
            sid = upsert_ts(
                conn,
                name,
                ak,
                int(book["op"]),
                {
                    "displayLabel": f"{label_map.get(role, role)} OP{book['op']} lot{book['lot']}",
                    "lotPercentOverride": book["lot"],
                    "reinvestPercentOverride": book.get("ri", 100),
                    "maxOpenPositions": book["op"],
                    "role": f"{role}_addon",
                    "universe": uni,
                    "pack": "hamfive_aug2026",
                },
            )
            replace_members(conn, sid, sids, "addon")
            addon_ts[tag] = {"id": sid, "name": name, "n": len(sids), "role": role}
            keep_names.add(name)
            print(f"addon {tag} id={sid} n={len(sids)} op={book['op']} lot={book['lot']}")

    published = []
    for pf in recipes["portfolios"]:
        members = []
        for book in pf["books"]:
            if book["key"] == "b3":
                members.append(
                    {
                        "system_name": b3_name,
                        "role": "b3",
                        "weight": float(book.get("initial") or 10000) / 10000.0,
                    }
                )
            else:
                pack = addon_ts[book["tsTag"]]
                members.append(
                    {
                        "system_name": pack["name"],
                        "role": book["key"],
                        "weight": float(book.get("initial") or 0) / 10000.0 if book.get("initial") else 0.5,
                    }
                )
        snap = dict(snaps.get(pf["id"]) or {})
        meta_books = []
        for book in pf["books"]:
            b = dict(book)
            if book["key"] == "b3":
                b.update(
                    {
                        "op": recipes["sharedB3"]["op"],
                        "lot": recipes["sharedB3"]["lot"],
                        "ri": recipes["sharedB3"]["ri"],
                    }
                )
            meta_books.append(b)
        meta = {
            "books": meta_books,
            "character": pf.get("character"),
            "pack": "hamfive_aug2026",
            "bt": {k: snap.get(k) for k in ("ret", "dd", "capital", "method", "retNoStocks", "ddNoStocks")},
        }
        desc = str(
            pf.get("character")
            or f"{pf['label']}: B3 + HAM ZZ + FIVECARD + stocks ZZ"
        )
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

    retire_info = {"retiredTs": [], "archivedStrategies": 0}
    if not args.skip_retire:
        retire_info = retire_old_masters(
            conn,
            list(recipes.get("retireMasterPrefixes") or []),
            keep_names,
        )
        print(f"retired TS={len(retire_info['retiredTs'])} archived orphan strats={retire_info['archivedStrategies']}")
        for n in retire_info["retiredTs"]:
            print(f"  retire {n}")

    conn.commit()
    out_path = os.path.join(DATA, "last_publish_hamfive.json")
    json.dump(
        {
            "generatedAt": now(),
            "db": DB,
            "b3": b3_name,
            "addons": addon_ts,
            "portfolios": published,
            "retire": retire_info,
        },
        open(out_path, "w"),
        indent=2,
    )
    print(f"Wrote {out_path}")
    conn.close()


if __name__ == "__main__":
    main()

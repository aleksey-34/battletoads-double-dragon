#!/usr/bin/env python3
"""Stamp live hamfive cards with fearBoost + tier CB, refresh storefront snapshots, ensure HAM/FIVE ri=100.

Does NOT rematerialize (no new legs, no orphan closes). Runtime reads master_cards
metadata on the next cycle (config TTL 60s).

  BTDD_DB_PATH=/opt/battletoads-double-dragon/backend/database.db \\
    python3 scripts/hybrid/stamp_fear_boost_live_aug2026.py --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "portfolio_six_data_jul2026"
DB = os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE") or str(REPO / "backend" / "database.db")

TIER_CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
    "applyToStrategyTypes": ["zz_breakout"],
}
FEAR = {
    "enabled": True,
    "lotMultiplier": 1.25,
    "holdDays": 2,
    "btcDailyReturnLte": -0.03,
    "spxDailyReturnLte": -0.015,
    "vixDailyChangeGte": 0.15,
}

CARD_NEEDLES = (
    "PORTFOLIO-B3-CORE-SHARED-JUL2026",
    "ADDON-HAM-",
    "ADDON-FIVE-",
    "ADDON-STOCKS-ZZ",
    "PORTFOLIO-CONSERVATIVE-JUL2026",
    "PORTFOLIO-BALANCED-JUL2026",
    "PORTFOLIO-AGGRESSIVE-JUL2026",
    "PORTFOLIO-QUALITY",
    "PORTFOLIO-TRIPLE",
    "PORTFOLIO-WHALE",
)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def load_snaps() -> dict:
    return json.loads((DATA / "snapshots_hamfive_aug2026.json").read_text(encoding="utf-8"))


def is_hamfive_card(code: str, meta: dict) -> bool:
    code_u = str(code or "").upper()
    if any(n in code_u for n in CARD_NEEDLES):
        return True
    pack = str(meta.get("pack") or "")
    if pack == "hamfive_aug2026":
        return True
    return False


def patch_meta(meta: dict) -> dict:
    out = dict(meta)
    out["pack"] = out.get("pack") or "hamfive_aug2026"
    out["portfolioCircuitBreaker"] = dict(TIER_CB)
    out["fearBoost"] = dict(FEAR)
    bs = out.get("backtestSettings")
    if isinstance(bs, dict):
        bs = dict(bs)
        bs["portfolioCircuitBreaker"] = dict(TIER_CB)
        bs["fearBoost"] = dict(FEAR)
        out["backtestSettings"] = bs
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true")
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args()
    if not args.apply and not args.dry_run:
        raise SystemExit("pass --apply or --dry-run")

    snaps = load_snaps()
    recipes = json.loads((DATA / "recipes_hamfive_aug2026.json").read_text(encoding="utf-8"))
    set_key_by_id = {p["id"]: p["setKey"] for p in recipes["portfolios"]}

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    cards = conn.execute(
        "SELECT code, metadata_json FROM master_cards WHERE COALESCE(is_active,1)=1"
    ).fetchall()
    card_hits = []
    for row in cards:
        meta = {}
        try:
            meta = json.loads(row["metadata_json"] or "{}")
        except json.JSONDecodeError:
            meta = {}
        if not is_hamfive_card(row["code"], meta):
            continue
        card_hits.append(row["code"])
        if args.apply:
            conn.execute(
                "UPDATE master_cards SET metadata_json=?, updated_at=? WHERE code=?",
                (json.dumps(patch_meta(meta), ensure_ascii=False), now(), row["code"]),
            )

    pf_hits = []
    for pf_id, set_key in set_key_by_id.items():
        snap = snaps.get(pf_id)
        if not snap:
            continue
        row = conn.execute(
            "SELECT id, metadata_json, snapshot_json FROM algofund_portfolios WHERE set_key=?",
            (set_key,),
        ).fetchone()
        if not row:
            continue
        pf_hits.append({"id": pf_id, "setKey": set_key, "ret": snap.get("ret"), "dd": snap.get("dd")})
        if args.apply:
            meta = {}
            try:
                meta = json.loads(row["metadata_json"] or "{}")
            except json.JSONDecodeError:
                meta = {}
            meta = patch_meta(meta)
            meta["bt"] = {k: snap.get(k) for k in ("ret", "dd", "capital", "method", "retNoStocks", "ddNoStocks", "overlay", "ri")}
            conn.execute(
                """UPDATE algofund_portfolios
                   SET metadata_json=?, snapshot_json=?, updated_at=? WHERE id=?""",
                (
                    json.dumps(meta, ensure_ascii=False),
                    json.dumps(snap, ensure_ascii=False),
                    now(),
                    int(row["id"]),
                ),
            )

    ri_before = conn.execute(
        """SELECT
             SUM(CASE WHEN s.name LIKE 'PF6::HAM::%' OR s.name LIKE 'PF6::FIVE::%' OR s.name LIKE 'PF6::STOCKSZZ::%' THEN 1 ELSE 0 END) AS pf6,
             SUM(CASE WHEN s.name LIKE 'PF6::HAM::%' OR s.name LIKE 'PF6::FIVE::%' OR s.name LIKE 'PF6::STOCKSZZ::%' THEN s.reinvest_percent ELSE 0 END) AS pf6_ri_sum
           FROM strategies s WHERE COALESCE(s.is_archived,0)=0"""
    ).fetchone()

    ri_updated = 0
    if args.apply:
        cur = conn.execute(
            """UPDATE strategies SET reinvest_percent=100, updated_at=?
               WHERE COALESCE(is_archived,0)=0
                 AND (
                   name LIKE 'PF6::HAM::%' OR name LIKE 'PF6::FIVE::%' OR name LIKE 'PF6::STOCKSZZ::%'
                   OR name LIKE '%::HAM::%' OR name LIKE '%::FIVE::MRS%' OR name LIKE '%::STOCKSZZ::%'
                 )
                 AND COALESCE(reinvest_percent,0) < 100""",
            (now(),),
        )
        ri_updated = int(cur.rowcount or 0)

    if args.apply:
        conn.commit()
    print(f"DB={DB} apply={bool(args.apply)}")
    print(f"master_cards stamped: {len(card_hits)}")
    for c in card_hits:
        print(f"  {c}")
    print(f"portfolios stamped: {len(pf_hits)}")
    for p in pf_hits:
        print(f"  {p['id']} {p['setKey']} ret={p['ret']} dd={p['dd']}")
    print(f"PF6-named rows={ri_before['pf6']} reinvest_bumped={ri_updated}")
    print("remat: NOT needed (lot overlay + snapshot + reinvest column)")
    conn.close()


if __name__ == "__main__":
    main()

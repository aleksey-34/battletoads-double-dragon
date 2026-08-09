#!/usr/bin/env python3
"""Fix algofund_portfolios metadata.books to include stocks sleeve + capital.

Dry-run by default. Apply with --run.

  BTDD_DB_PATH=... python3 scripts/hybrid/stamp_portfolio_staggered_stocks_aug2026.py --dry-run
  BTDD_DB_PATH=... python3 scripts/hybrid/stamp_portfolio_staggered_stocks_aug2026.py --run --apply-meta-only
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from copy import deepcopy
from datetime import datetime, timezone

STOCKS_BOOK = {
    "key": "stocks",
    "initial": 5000,
    "op": 6,
    "lot": 15,
    "ri": 100,
    "role": "stocks",
    "setKey": "addon-mrs-weex-stocks-shortma-jul2026",
    "joinDate": "2026-06-17",
    "note": "WEEX short-MA sleeve; staggered join — not full-window 1y history",
}

# recipe capital with stocks: b3+mrs(+zz) + 5k stocks
CAPITAL_WITH_STOCKS = {
    "portfolio-conservative-jul2026": 25000,
    "portfolio-balanced-jul2026": 25000,
    "portfolio-aggressive-jul2026": 35000,
    "portfolio-quality-tilt-jul2026": 25000,
    "portfolio-triple-zz-jul2026": 30000,
    "portfolio-whale-personal-jul2026": 35000,
}


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def ensure_stocks_book(books: list) -> list:
    out = []
    seen = False
    for b in books or []:
        if not isinstance(b, dict):
            continue
        key = str(b.get("key") or b.get("role") or "")
        if key == "stocks":
            merged = {**b, **STOCKS_BOOK}
            out.append(merged)
            seen = True
        else:
            out.append(b)
    if not seen:
        out.append(dict(STOCKS_BOOK))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--apply-meta-only", action="store_true", help="only fix metadata.books + capital; no BT stamp")
    args = ap.parse_args()
    if not args.db:
        raise SystemExit("set --db or BTDD_DB_PATH")
    if not args.dry_run and not args.run:
        raise SystemExit("pass --dry-run or --run")

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, set_key, snapshot_json, metadata_json FROM algofund_portfolios WHERE COALESCE(is_enabled,1)=1"
    ).fetchall()

    report = []
    for row in rows:
        sk = row["set_key"]
        snap = json.loads(row["snapshot_json"] or "{}")
        meta = json.loads(row["metadata_json"] or "{}")
        before_books = deepcopy(meta.get("books") or [])
        before_cap = snap.get("capital")
        meta["books"] = ensure_stocks_book(before_books)
        meta["stocksJoin"] = {
            "joinDate": STOCKS_BOOK["joinDate"],
            "method": "per_book_equity_sum_with_delayed_join",
            "label": "stocks sleeve joins when all legs have candles; not 1y annualized",
            "updatedAt": now(),
        }
        # Do NOT bump snapshot.capital until an honest BT stamp lands — old ret%
        # figures (sometimes unbounded) would imply wrong deposit sizing on UI.
        # Target capitals live in CAPITAL_WITH_STOCKS / stocksJoin for rerun only.
        meta["targetCapitalWithStocks"] = CAPITAL_WITH_STOCKS.get(sk)
        report.append(
            {
                "set_key": sk,
                "before": {"capital": before_cap, "books": [b.get("key") for b in before_books]},
                "after": {
                    "capital": snap.get("capital"),
                    "books": [b.get("key") for b in meta["books"]],
                    "stocks": next((b for b in meta["books"] if b.get("key") == "stocks"), None),
                },
            }
        )
        if args.run and args.apply_meta_only:
            conn.execute(
                "UPDATE algofund_portfolios SET snapshot_json=?, metadata_json=?, updated_at=? WHERE id=?",
                (json.dumps(snap, ensure_ascii=False), json.dumps(meta, ensure_ascii=False), now(), row["id"]),
            )

    if args.run and args.apply_meta_only:
        conn.commit()

    print(json.dumps({"mode": "run" if args.run else "dry-run", "portfolios": report}, indent=2, ensure_ascii=False))
    conn.close()


if __name__ == "__main__":
    main()

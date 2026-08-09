#!/usr/bin/env python3
"""Repair algofund_portfolios metadata.books for the WEEX stocks sleeve.

The stocks sleeve exists in algofund_portfolio_members (role=stocks, weight 0.5) but
metadata.books still only lists b3/mrs(/zz). The admin "real rerun" resolves a book's
op/lot/ri from metadata.books by key, so the stocks book silently runs with op=0,
lot=0, ri=0. This adds the missing entry and records how the sleeve joins history.

It does NOT write backtest numbers. The stamped snapshot.ret/dd stay untouched — see
--capital-mode and the stampStatus block for why.

  # inspect (safe, no writes)
  python3 scripts/hybrid/stamp_portfolio_staggered_stocks_aug2026.py --db path/to.db --dry-run

  # apply metadata only (VPS)
  python3 scripts/hybrid/stamp_portfolio_staggered_stocks_aug2026.py --db path/to.db --apply-meta
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from copy import deepcopy
from datetime import datetime, timezone

# Matches scripts/hybrid/portfolio_six_data_jul2026/recipes.json sharedStocks.
STOCKS_BOOK = {
    "key": "stocks",
    "initial": 5000,
    "op": 6,
    "lot": 15,
    "ri": 100,
    "role": "stocks",
    "setKey": "addon-mrs-weex-stocks-shortma-jul2026",
    "note": "WEEX short-MA sleeve. Own OP book; B3 stays the trend sleeve.",
}

# Date all 8 WEEX stock legs have candles (BABAUSDT is the last to start).
STOCKS_JOIN_DATE = "2026-06-17"

STAGGERED_JOIN = {
    "dateFrom": "full",
    "joinDate": STOCKS_JOIN_DATE,
    "method": "per_book_equity_sum_with_delayed_join",
    "rule": (
        "B3/MRS(/ZZ) run the full window. The stocks book holds its $5000 as idle cash "
        "from t0 and joins the equity sum at joinDate, when all 8 legs have candles. "
        "Never splice the sleeve's short-window return percentage onto the long window."
    ),
    "joinDateBasis": "earliest date all 8 WEEX stock legs have 4h candles",
    "artifact": "results/stocks_hf_research_aug2026/staggered_portfolio_bt.json",
}

# Shared-deposit model: adding stocks does NOT bump client capital.
# `with-stocks` mode is legacy/wrong (additive cash) — kept only for forensics.
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
    """Merge the stocks entry in place if present, else append it after the other books."""
    out = []
    seen = False
    for b in books or []:
        if not isinstance(b, dict):
            continue
        if str(b.get("key") or b.get("role") or "") == "stocks":
            out.append({**b, **STOCKS_BOOK})
            seen = True
        else:
            out.append(b)
    if not seen:
        out.append(dict(STOCKS_BOOK))
    return out


def core_capital(books: list) -> int:
    """Capital of the non-stocks books — the basis the stamped ret% was computed on."""
    total = 0
    for b in books or []:
        if isinstance(b, dict) and str(b.get("key") or "") != "stocks":
            total += int(b.get("initial") or 0)
    return total


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE"))
    ap.add_argument("--dry-run", action="store_true", help="report only, no writes")
    ap.add_argument("--apply-meta", action="store_true", help="write metadata.books + join docs")
    ap.add_argument(
        "--capital-mode",
        choices=["keep", "with-stocks", "core"],
        default="keep",
        help=(
            "keep (default): leave snapshot.capital alone — correct shared-deposit model; "
            "with-stocks: LEGACY WRONG additive cash (b3+mrs+5k); "
            "core: set to sum of non-stocks book initials"
        ),
    )
    args = ap.parse_args()
    if not args.db:
        raise SystemExit("set --db or BTDD_DB_PATH")
    if not args.dry_run and not args.apply_meta:
        raise SystemExit("pass --dry-run or --apply-meta")

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute(
        "SELECT id, set_key, snapshot_json, metadata_json FROM algofund_portfolios"
        " WHERE COALESCE(is_enabled,1)=1 ORDER BY id"
    ).fetchall()

    report = []
    for row in rows:
        sk = row["set_key"]
        snap = json.loads(row["snapshot_json"] or "{}")
        meta = json.loads(row["metadata_json"] or "{}")
        before_books = deepcopy(meta.get("books") or [])
        before_cap = snap.get("capital")

        meta["books"] = ensure_stocks_book(before_books)
        meta["stocksJoin"] = {**STAGGERED_JOIN, "updatedAt": now()}
        meta["targetCapitalWithStocks"] = None  # shared deposit: no capital bump
        meta["sharedDepositModel"] = {
            "rule": "one_client_deposit",
            "note": "Adding a TS/book allocates OP/lot/weight on the same snapshot.capital; it does not add cash.",
            "updatedAt": now(),
        }

        # The stamped ret/dd/curve predate the stocks book. Record that instead of
        # silently letting a bumped capital imply the sleeve was in the backtest.
        basis = core_capital(meta["books"])
        stamped_ret = (meta.get("bt") or {}).get("ret")
        meta["stampStatus"] = {
            "btIncludesStocks": False,
            "stampedRetCapitalBasis": basis,
            "displayedCapital": before_cap,
            "consistent": before_cap == basis,
            "reason": (
                "snapshot.ret/dd/curve come from a b3+mrs(+zz) run; the stocks book was "
                "not in that backtest. Displayed capital above the basis overstates "
                "return per funded dollar."
            ),
            "updatedAt": now(),
        }

        if args.capital_mode == "with-stocks":
            snap["capital"] = CAPITAL_WITH_STOCKS.get(sk, snap.get("capital"))
        elif args.capital_mode == "core":
            snap["capital"] = basis

        report.append({
            "set_key": sk,
            "before": {
                "capital": before_cap,
                "books": [b.get("key") for b in before_books],
                "stampedRet": stamped_ret,
            },
            "after": {
                "capital": snap.get("capital"),
                "books": [b.get("key") for b in meta["books"]],
                "stocksBook": next((b for b in meta["books"] if b.get("key") == "stocks"), None),
            },
            "capitalConsistent": snap.get("capital") == basis,
            "stampedRetCapitalBasis": basis,
        })

        if args.apply_meta:
            conn.execute(
                "UPDATE algofund_portfolios SET snapshot_json=?, metadata_json=?, updated_at=?"
                " WHERE id=?",
                (
                    json.dumps(snap, ensure_ascii=False),
                    json.dumps(meta, ensure_ascii=False),
                    now(),
                    row["id"],
                ),
            )

    if args.apply_meta:
        conn.commit()

    print(json.dumps(
        {
            "mode": "apply-meta" if args.apply_meta else "dry-run",
            "capitalMode": args.capital_mode,
            "db": args.db,
            "stocksJoin": STAGGERED_JOIN,
            "portfolios": report,
        },
        indent=2,
        ensure_ascii=False,
    ))
    conn.close()


if __name__ == "__main__":
    main()

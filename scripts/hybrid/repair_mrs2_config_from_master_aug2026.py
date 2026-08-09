#!/usr/bin/env python3
"""Repair live MeanReversion/MRS2 legs: copy mrs2_config_json + zscore_* from master SID.

Client legs were materialized without mrs2_config_json; zscore_exit/stop got DD-clamped
and inverted the MA bands. extractMrs2Params prefers mrs2_config_json, so restoring it
is enough for correct live signals.

Usage:
  BTDD_DB_PATH=/opt/.../database.db python3 scripts/hybrid/repair_mrs2_config_from_master_aug2026.py --dry-run
  BTDD_DB_PATH=... python3 ... --run --keys arcopy1,icopy1-api,Copy_Alex1
  BTDD_DB_PATH=... python3 ... --run --all-active
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
from datetime import datetime, timezone

SID_RE = re.compile(r"::SID(\d+)$")


def now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE"))
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--run", action="store_true")
    ap.add_argument("--keys", default="", help="comma-separated api key names")
    ap.add_argument("--all-active", action="store_true", help="all active MR legs with empty mrs2")
    args = ap.parse_args()
    if not args.db:
        raise SystemExit("set --db or BTDD_DB_PATH")
    if not args.dry_run and not args.run:
        raise SystemExit("pass --dry-run or --run")

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    key_filter = [k.strip() for k in args.keys.split(",") if k.strip()]
    where = [
        "s.strategy_type IN ('MeanReversion','MRS2')",
        "COALESCE(s.is_archived,0)=0",
    ]
    params: list = []
    if key_filter:
        where.append(f"a.name IN ({','.join('?' * len(key_filter))})")
        params.extend(key_filter)
    elif args.all_active:
        where.append("COALESCE(s.is_active,0)=1")
    else:
        raise SystemExit("pass --keys or --all-active")

    clients = conn.execute(
        f"""
        SELECT s.id, s.name, a.name AS api_key, s.base_symbol, s.interval,
               s.zscore_entry, s.zscore_exit, s.zscore_stop,
               COALESCE(s.mrs2_config_json,'{{}}') AS mrs2
        FROM strategies s
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE {' AND '.join(where)}
        ORDER BY a.name, s.base_symbol
        """,
        params,
    ).fetchall()

    fixed = 0
    skipped = 0
    missing_master = 0
    already_ok = 0
    samples = []

    for row in clients:
        mrs2 = (row["mrs2"] or "").strip()
        if mrs2 and mrs2 != "{}":
            # still fix zscores if they look clamped vs master
            pass
        m = SID_RE.search(row["name"] or "")
        if not m:
            skipped += 1
            continue
        sid = int(m.group(1))
        master = conn.execute(
            """
            SELECT id, zscore_entry, zscore_exit, zscore_stop, price_channel_length,
                   COALESCE(mrs2_config_json,'{}') AS mrs2
            FROM strategies WHERE id=?
            """,
            (sid,),
        ).fetchone()
        if not master:
            missing_master += 1
            continue
        master_mrs2 = (master["mrs2"] or "").strip() or "{}"
        if master_mrs2 == "{}":
            missing_master += 1
            continue

        needs = (
            mrs2 in ("", "{}")
            or float(row["zscore_exit"] or 0) != float(master["zscore_exit"] or 0)
            or float(row["zscore_stop"] or 0) != float(master["zscore_stop"] or 0)
            or float(row["zscore_entry"] or 0) != float(master["zscore_entry"] or 0)
        )
        if not needs:
            already_ok += 1
            continue

        samples.append(
            {
                "client": row["api_key"],
                "id": row["id"],
                "symbol": row["base_symbol"],
                "before": {
                    "zin": row["zscore_entry"],
                    "zout": row["zscore_exit"],
                    "zstop": row["zscore_stop"],
                    "mrs2_len": len(mrs2),
                },
                "after": {
                    "zin": master["zscore_entry"],
                    "zout": master["zscore_exit"],
                    "zstop": master["zscore_stop"],
                    "mrs2_len": len(master_mrs2),
                },
                "master_id": sid,
            }
        )

        if args.run:
            conn.execute(
                """
                UPDATE strategies
                SET mrs2_config_json=?,
                    zscore_entry=?,
                    zscore_exit=?,
                    zscore_stop=?,
                    price_channel_length=COALESCE(?, price_channel_length),
                    last_error=NULL,
                    updated_at=?
                WHERE id=?
                """,
                (
                    master_mrs2,
                    master["zscore_entry"],
                    master["zscore_exit"],
                    master["zscore_stop"],
                    master["price_channel_length"],
                    now(),
                    row["id"],
                ),
            )
        fixed += 1

    if args.run:
        conn.commit()

    print(
        json.dumps(
            {
                "mode": "run" if args.run else "dry-run",
                "scanned": len(clients),
                "fixed": fixed,
                "already_ok": already_ok,
                "skipped_no_sid": skipped,
                "missing_master": missing_master,
                "samples": samples[:20],
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    conn.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Safe BTDD main DB retention cleanup.

Preserves:
  - All strategies referenced by active master cards, trading systems, portfolios,
    runtime/active strategies, active card deployments.
  - Full backtest_runs JSON (trades/equity) for pinned runs, portfolio/TS runs,
    and latest single-strategy run per protected strategy (portfolio_backtest.py).
  - live_trade_events, tenants, api_keys, runtime state.

Trims:
  - Non-protected backtest_runs: strip heavy JSON blobs (keep scalar summary).
  - Old stripped runs, old predictions/reconciliation for non-protected strategies.
  - Orphan inactive strategies (not referenced anywhere).

Usage:
  python3 scripts/admin_tools/db_retention_cleanup.py --dry-run
  python3 scripts/admin_tools/db_retention_cleanup.py --apply
  python3 scripts/admin_tools/db_retention_cleanup.py --apply --vacuum

Env:
  DB_PATH, RETENTION_DAYS (default 90), PINNED_BACKTEST_RUN_IDS (default 360)
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DEFAULT_DB = REPO / "backend" / "database.db"

PINNED_DEFAULT = "360"


def parse_ids(raw: str) -> set[int]:
    out: set[int] = set()
    for part in str(raw or "").split(","):
        part = part.strip()
        if not part:
            continue
        try:
            out.add(int(part))
        except ValueError:
            pass
    return out


def parse_strategy_ids_json(raw: str | None) -> set[int]:
    if not raw:
        return set()
    try:
        data = json.loads(raw)
    except Exception:
        return set()
    if not isinstance(data, list):
        return set()
    out: set[int] = set()
    for item in data:
        try:
            out.add(int(item))
        except (TypeError, ValueError):
            pass
    return out


def load_protected_strategy_ids(conn: sqlite3.Connection) -> set[int]:
    sql = """
    SELECT DISTINCT strategy_id FROM (
      SELECT mcm.strategy_id
      FROM master_card_members mcm
      JOIN master_cards mc ON mc.id = mcm.card_id
      WHERE COALESCE(mc.is_active, 0) = 1

      UNION
      SELECT tsm.strategy_id
      FROM trading_system_members tsm
      JOIN trading_systems ts ON ts.id = tsm.system_id
      WHERE COALESCE(ts.is_active, 0) = 1

      UNION
      SELECT tsm.strategy_id
      FROM card_deployments cd
      JOIN trading_systems ts ON ts.id = cd.materialized_system_id
      JOIN trading_system_members tsm ON tsm.system_id = ts.id
      WHERE COALESCE(cd.status, '') != 'inactive'

      UNION
      SELECT s.id
      FROM strategies s
      WHERE COALESCE(s.is_runtime, 0) = 1
         OR COALESCE(s.is_active, 0) = 1
         OR COALESCE(s.is_archived, 0) = 1
    )
    WHERE strategy_id IS NOT NULL
    """
    rows = conn.execute(sql).fetchall()
    return {int(r[0]) for r in rows if r[0] is not None}


def file_mb(path: Path) -> float:
    if not path.exists():
        return 0.0
    return path.stat().st_size / (1024 * 1024)


def cutoff_sql(days: int) -> str:
    return (datetime.now(timezone.utc) - timedelta(days=days)).strftime("%Y-%m-%d %H:%M:%S")


def main() -> int:
    parser = argparse.ArgumentParser(description="BTDD safe DB retention cleanup")
    parser.add_argument("--db", default=os.environ.get("DB_PATH", str(DEFAULT_DB)))
    parser.add_argument("--dry-run", action="store_true", help="Report only (default if no --apply)")
    parser.add_argument("--apply", action="store_true", help="Execute changes")
    parser.add_argument("--vacuum", action="store_true", help="VACUUM after apply (needs exclusive lock)")
    parser.add_argument("--retention-days", type=int, default=int(os.environ.get("RETENTION_DAYS", "90")))
    parser.add_argument(
        "--pinned-runs",
        default=os.environ.get("PINNED_BACKTEST_RUN_IDS", PINNED_DEFAULT),
        help="Comma-separated backtest_run ids to always keep full JSON",
    )
    parser.add_argument(
        "--purge-orphans",
        action="store_true",
        help="Also DELETE inactive unreferenced strategies (off by default)",
    )
    args = parser.parse_args()
    apply = bool(args.apply)
    dry_run = not apply

    db_path = Path(args.db)
    if not db_path.exists():
        print(f"ERROR: DB not found: {db_path}", file=sys.stderr)
        return 1

    pinned_runs = parse_ids(args.pinned_runs)
    retention_days = max(30, int(args.retention_days))
    cutoff = cutoff_sql(retention_days)

    print(f"DB: {db_path} ({file_mb(db_path):.1f} MB)")
    print(f"Mode: {'DRY-RUN' if dry_run else 'APPLY'} | retention={retention_days}d | pinned_runs={sorted(pinned_runs)}")

    conn = sqlite3.connect(str(db_path), timeout=120)
    conn.execute("PRAGMA busy_timeout = 120000")
    conn.row_factory = sqlite3.Row

    protected_sids = load_protected_strategy_ids(conn)
    print(f"Protected strategy IDs: {len(protected_sids)}")

    runs = conn.execute(
        "SELECT id, api_key_name, strategy_ids, created_at, "
        "length(COALESCE(equity_curve_json,'')) + length(COALESCE(trades_json,'')) + length(COALESCE(request_json,'')) AS blob_len "
        "FROM backtest_runs ORDER BY id"
    ).fetchall()

    keep_full_json: set[int] = set(pinned_runs)
    latest_single_by_sid: dict[int, int] = {}

    # Latest single-strategy run per protected sid (portfolio_backtest.py contract)
    for row in runs:
        rid = int(row["id"])
        sids = parse_strategy_ids_json(row["strategy_ids"])
        if len(sids) == 1:
            sid = next(iter(sids))
            if sid in protected_sids:
                prev = latest_single_by_sid.get(sid)
                if prev is None or rid > prev:
                    latest_single_by_sid[sid] = rid

    keep_full_json.update(latest_single_by_sid.values())

    # Latest portfolio / multi-leg runs per api key (full sweeps — keep newest few only)
    portfolio_by_key: dict[str, list[int]] = {}
    for row in runs:
        rid = int(row["id"])
        sids = parse_strategy_ids_json(row["strategy_ids"])
        if len(sids) < 2:
            continue
        key = str(row["api_key_name"] or "")
        portfolio_by_key.setdefault(key, []).append(rid)
    for _key, ids in portfolio_by_key.items():
        for rid in sorted(ids, reverse=True)[:3]:
            keep_full_json.add(rid)

    # Active card member sets: keep best matching multi-strategy run per card (if any)
    card_rows = conn.execute(
        """
        SELECT mc.id, GROUP_CONCAT(mcm.strategy_id) AS sids
        FROM master_cards mc
        JOIN master_card_members mcm ON mcm.card_id = mc.id
        WHERE COALESCE(mc.is_active, 0) = 1
        GROUP BY mc.id
        """
    ).fetchall()
    for card in card_rows:
        try:
            member_sids = {int(x) for x in str(card["sids"] or "").split(",") if x.strip()}
        except ValueError:
            continue
        if len(member_sids) < 2:
            continue
        best_rid = None
        best_overlap = 0
        for row in runs:
            rid = int(row["id"])
            sids = parse_strategy_ids_json(row["strategy_ids"])
            if len(sids) < 2:
                continue
            overlap = len(sids & member_sids)
            if overlap > best_overlap:
                best_overlap = overlap
                best_rid = rid
        if best_rid is not None and best_overlap >= max(2, len(member_sids) // 4):
            keep_full_json.add(best_rid)

    # Recent runs per active api key (UI / btRtSweep headroom)
    active_keys = {
        r[0]
        for r in conn.execute(
            """
            SELECT DISTINCT a.name
            FROM api_keys a
            JOIN strategies s ON s.api_key_id = a.id
            WHERE COALESCE(s.is_active,0)=1 OR COALESCE(s.is_runtime,0)=1
            """
        ).fetchall()
    }
    runs_by_key: dict[str, list[int]] = {}
    for row in runs:
        key = str(row["api_key_name"] or "")
        if key in active_keys:
            runs_by_key.setdefault(key, []).append(int(row["id"]))
    for key, ids in runs_by_key.items():
        for rid in sorted(ids, reverse=True)[:5]:
            keep_full_json.add(rid)

    strip_ids: list[int] = []
    delete_run_ids: list[int] = []
    strip_bytes = 0
    for row in runs:
        rid = int(row["id"])
        blob = int(row["blob_len"] or 0)
        if blob <= 0:
            continue
        if rid in keep_full_json:
            continue
        created = str(row["created_at"] or "")
        strip_ids.append(rid)
        strip_bytes += blob
        if created and created < cutoff:
            delete_run_ids.append(rid)

    # Predictions + reconciliation for non-protected strategies
    if protected_sids:
        placeholders = ",".join("?" * len(protected_sids))
        pred_old = conn.execute(
            f"SELECT COUNT(*) FROM backtest_predictions WHERE created_at < ? AND strategy_id NOT IN ({placeholders})",
            [int((datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp() * 1000), *protected_sids],
        ).fetchone()[0]
        recon_old = conn.execute(
            f"SELECT COUNT(*) FROM reconciliation_reports WHERE created_at < ? AND strategy_id NOT IN ({placeholders})",
            [int((datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp() * 1000), *protected_sids],
        ).fetchone()[0]
    else:
        pred_old = conn.execute(
            "SELECT COUNT(*) FROM backtest_predictions WHERE created_at < ?",
            [int((datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp() * 1000)],
        ).fetchone()[0]
        recon_old = conn.execute(
            "SELECT COUNT(*) FROM reconciliation_reports WHERE created_at < ?",
            [int((datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp() * 1000)],
        ).fetchone()[0]

    orphan_strategies = conn.execute(
        f"""
        SELECT COUNT(*) FROM strategies s
        WHERE COALESCE(s.is_active,0)=0
          AND COALESCE(s.is_runtime,0)=0
          AND COALESCE(s.is_archived,0)=0
          AND datetime(COALESCE(s.updated_at, s.created_at, '1970-01-01')) < datetime(?)
          AND s.id NOT IN ({",".join("?" * len(protected_sids)) if protected_sids else "SELECT -1"})
          AND NOT EXISTS (SELECT 1 FROM trading_system_members tsm WHERE tsm.strategy_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM master_card_members mcm WHERE mcm.strategy_id = s.id)
          AND NOT EXISTS (SELECT 1 FROM live_trade_events lte WHERE lte.strategy_id = s.id)
        """,
        [cutoff, *protected_sids] if protected_sids else [cutoff],
    ).fetchone()[0]

    print("\n--- Plan ---")
    print(f"backtest_runs total: {len(runs)}")
    print(f"keep full JSON: {len(keep_full_json)} (incl. {len(latest_single_by_sid)} latest single-strategy per protected sid)")
    print(f"strip JSON blobs: {len(strip_ids)} runs (~{strip_bytes / (1024*1024):.0f} MB payload)")
    print(f"delete old stripped runs (created<{cutoff}): {len(delete_run_ids)}")
    print(f"delete backtest_predictions (non-protected, >{retention_days}d): {pred_old}")
    print(f"delete reconciliation_reports (non-protected, >{retention_days}d): {recon_old}")
    print(f"delete orphan inactive strategies: {orphan_strategies}{'' if args.purge_orphans else ' (skipped unless --purge-orphans)'}")

    if dry_run:
        print("\nDry-run complete. Re-run with --apply to execute.")
        conn.close()
        return 0

    print("\nApplying...")
    conn.execute("BEGIN IMMEDIATE")
    try:
        if strip_ids:
            for i in range(0, len(strip_ids), 200):
                batch = strip_ids[i : i + 200]
                ph = ",".join("?" * len(batch))
                conn.execute(
                    f"""
                    UPDATE backtest_runs
                    SET equity_curve_json = NULL,
                        trades_json = NULL,
                        request_json = NULL
                    WHERE id IN ({ph})
                      AND id NOT IN ({",".join("?" * len(keep_full_json)) if keep_full_json else "-1"})
                    """,
                    [*batch, *keep_full_json],
                )

        if delete_run_ids:
            for i in range(0, len(delete_run_ids), 200):
                batch = delete_run_ids[i : i + 200]
                ph = ",".join("?" * len(batch))
                conn.execute(
                    f"DELETE FROM backtest_runs WHERE id IN ({ph}) AND id NOT IN ({','.join('?' * len(keep_full_json)) if keep_full_json else '-1'})",
                    [*batch, *keep_full_json],
                )

        cutoff_ms = int((datetime.now(timezone.utc) - timedelta(days=retention_days)).timestamp() * 1000)
        if protected_sids:
            ph = ",".join("?" * len(protected_sids))
            conn.execute(
                f"DELETE FROM backtest_predictions WHERE created_at < ? AND strategy_id NOT IN ({ph})",
                [cutoff_ms, *protected_sids],
            )
            conn.execute(
                f"DELETE FROM reconciliation_reports WHERE created_at < ? AND strategy_id NOT IN ({ph})",
                [cutoff_ms, *protected_sids],
            )
        else:
            conn.execute("DELETE FROM backtest_predictions WHERE created_at < ?", [cutoff_ms])
            conn.execute("DELETE FROM reconciliation_reports WHERE created_at < ?", [cutoff_ms])

        if args.purge_orphans and protected_sids and orphan_strategies:
            ph = ",".join("?" * len(protected_sids))
            conn.execute(
                f"""
                DELETE FROM strategies
                WHERE COALESCE(is_active,0)=0
                  AND COALESCE(is_runtime,0)=0
                  AND COALESCE(is_archived,0)=0
                  AND datetime(COALESCE(updated_at, created_at, '1970-01-01')) < datetime(?)
                  AND id NOT IN ({ph})
                  AND NOT EXISTS (SELECT 1 FROM trading_system_members tsm WHERE tsm.strategy_id = strategies.id)
                  AND NOT EXISTS (SELECT 1 FROM master_card_members mcm WHERE mcm.strategy_id = strategies.id)
                  AND NOT EXISTS (SELECT 1 FROM live_trade_events lte WHERE lte.strategy_id = strategies.id)
                """,
                [cutoff, *protected_sids],
            )

        conn.execute(
            """
            INSERT OR REPLACE INTO app_runtime_flags (key, value, updated_at)
            VALUES ('db_retention_last_run', ?, CURRENT_TIMESTAMP)
            """,
            [datetime.now(timezone.utc).isoformat()],
        )
        conn.commit()
    except Exception:
        conn.rollback()
        raise

    print(f"After apply (pre-vacuum): {file_mb(db_path):.1f} MB")

    if args.vacuum:
        print("VACUUM (may take several minutes)...")
        conn.execute("VACUUM")
        print(f"After VACUUM: {file_mb(db_path):.1f} MB")

    conn.close()
    print("Done.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

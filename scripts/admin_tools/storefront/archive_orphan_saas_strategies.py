#!/usr/bin/env python3
"""Archive active SAAS strategies that are not in the tenant trading system (orphans).

Safe mode: only archives strategies with no open position snapshot.
Use --dry-run first, then --apply for specific slugs.
"""
from __future__ import annotations

import argparse
import os
import sqlite3
from typing import Any

DB = os.environ.get(
    "BTDD_DB_PATH",
    os.path.join(os.environ.get("BTDD_REPO", "/opt/battletoads-double-dragon"), "backend", "database.db"),
)


def fetch_orphans(conn: sqlite3.Connection, slug: str | None) -> list[dict[str, Any]]:
    conn.row_factory = sqlite3.Row
    slug_filter = ""
    params: list[Any] = []
    if slug:
        slug_filter = "AND t.slug = ?"
        params.append(slug)

    rows = conn.execute(
        f"""
        SELECT t.slug,
               ts.id AS ts_id,
               s.id AS strategy_id,
               s.base_symbol,
               s.strategy_type,
               substr(s.name, 1, 80) AS name,
               COALESCE(NULLIF(ap.execution_api_key_name, ''), ap.assigned_api_key_name) AS api_key
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        JOIN api_keys ak ON ak.name = COALESCE(NULLIF(ap.execution_api_key_name, ''), ap.assigned_api_key_name)
        JOIN trading_systems ts ON ts.name = 'ALGOFUND::' || t.slug AND ts.api_key_id = ak.id
        JOIN strategies s ON s.api_key_id = ak.id
        WHERE t.status = 'active'
          AND s.name LIKE 'SAAS::%'
          AND COALESCE(s.is_archived, 0) = 0
          AND COALESCE(s.is_active, 1) = 1
          AND s.id NOT IN (SELECT strategy_id FROM trading_system_members WHERE system_id = ts.id)
          {slug_filter}
        ORDER BY t.slug, s.id
        """,
        params,
    ).fetchall()
    return [dict(r) for r in rows]


def has_open_position(conn: sqlite3.Connection, strategy_id: int, api_key: str) -> bool:
    tables = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}
    if "position_snapshots" in tables:
        cols = {r[1] for r in conn.execute("PRAGMA table_info(position_snapshots)").fetchall()}
        if "strategy_id" in cols:
            row = conn.execute(
                """
                SELECT 1 FROM position_snapshots
                WHERE strategy_id = ? AND COALESCE(size, 0) != 0
                LIMIT 1
                """,
                (strategy_id,),
            ).fetchone()
            if row:
                return True
        if "api_key_name" in cols and "symbol" in cols:
            sym_row = conn.execute("SELECT base_symbol FROM strategies WHERE id=?", (strategy_id,)).fetchone()
            if sym_row and sym_row[0]:
                row = conn.execute(
                    """
                    SELECT 1 FROM position_snapshots
                    WHERE api_key_name = ? AND symbol = ? AND COALESCE(size, 0) != 0
                    LIMIT 1
                    """,
                    (api_key, sym_row[0]),
                ).fetchone()
                if row:
                    return True
    if "positions" in tables:
        row = conn.execute(
            """
            SELECT 1 FROM positions
            WHERE strategy_id = ? AND COALESCE(size, 0) != 0
            LIMIT 1
            """,
            (strategy_id,),
        ).fetchone()
        if row:
            return True
    return False


def archive_strategy(conn: sqlite3.Connection, strategy_id: int) -> None:
    conn.execute(
        """
        UPDATE strategies
        SET is_archived = 1, is_active = 0, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
        """,
        (strategy_id,),
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="Archive orphan active SAAS strategies (flat only)")
    parser.add_argument("--slug", help="Limit to one tenant slug")
    parser.add_argument("--apply", action="store_true", help="Actually archive (default: dry-run)")
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    orphans = fetch_orphans(conn, args.slug)
    if not orphans:
        print("No orphan SAAS strategies found.")
        return

    by_slug: dict[str, list[dict[str, Any]]] = {}
    for o in orphans:
        by_slug.setdefault(o["slug"], []).append(o)

    archived = 0
    skipped_open = 0
    for slug, items in sorted(by_slug.items()):
        print(f"\n{slug}: {len(items)} orphan(s)")
        for o in items:
            open_pos = has_open_position(conn, o["strategy_id"], o["api_key"])
            status = "OPEN POSITION — skip" if open_pos else ("archive" if args.apply else "would archive")
            print(
                f"  id={o['strategy_id']} {o['base_symbol']} {o['strategy_type']} "
                f"{o['name']} → {status}"
            )
            if open_pos:
                skipped_open += 1
                continue
            if args.apply:
                archive_strategy(conn, o["strategy_id"])
                archived += 1

    if args.apply:
        conn.commit()
        print(f"\nArchived {archived}, skipped (open) {skipped_open}")
    else:
        print(f"\nDry-run: {len(orphans) - skipped_open} would archive, {skipped_open} skipped (open)")
        print("Re-run with --apply to commit.")


if __name__ == "__main__":
    main()

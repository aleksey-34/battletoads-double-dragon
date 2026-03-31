#!/usr/bin/env python3
import json
import sqlite3
import time
from datetime import datetime, timezone


DB = "/opt/battletoads-double-dragon/backend/database.db"
CLIENTS = [
    {"tenant_id": 41170, "name": "Ruslan"},
    {"tenant_id": 41232, "name": "Ali"},
]


def fetch_all(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [{cols[i]: row[i] for i in range(len(cols))} for row in cur.fetchall()]


def fetch_one(conn, sql, params=()):
    rows = fetch_all(conn, sql, params)
    return rows[0] if rows else None


def iso(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


def get_snapshot_delta(conn, api_key_name, lookback_hours):
    latest = fetch_one(
        conn,
        """
        SELECT m.recorded_at, m.equity_usd, m.unrealized_pnl, m.margin_load_percent
        FROM monitoring_snapshots m
        JOIN api_keys ak ON ak.id = m.api_key_id
        WHERE ak.name = ?
        ORDER BY datetime(m.recorded_at) DESC
        LIMIT 1
        """,
        (api_key_name,),
    )
    prev = fetch_one(
        conn,
        """
        SELECT m.recorded_at, m.equity_usd, m.unrealized_pnl, m.margin_load_percent
        FROM monitoring_snapshots m
        JOIN api_keys ak ON ak.id = m.api_key_id
        WHERE ak.name = ?
          AND datetime(m.recorded_at) <= datetime('now', ?)
        ORDER BY datetime(m.recorded_at) DESC
        LIMIT 1
        """,
        (api_key_name, f"-{lookback_hours} hours"),
    )
    if not latest:
        return {"latest": None, "previous": None, "equity_delta": None}
    delta = None
    if prev and latest.get("equity_usd") is not None and prev.get("equity_usd") is not None:
        delta = float(latest["equity_usd"]) - float(prev["equity_usd"])
    return {
        "latest": latest,
        "previous": prev,
        "equity_delta": delta,
    }


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    now_ms = int(time.time() * 1000)
    d1_ms = now_ms - 24 * 3600 * 1000
    d7_ms = now_ms - 7 * 24 * 3600 * 1000

    report = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "clients": [],
        "global_card_16_members": None,
    }

    # Card source system (what UI card represents)
    source_system = fetch_one(
        conn,
        """
        SELECT ts.id AS system_id, ts.name, ak.name AS api_key_name
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        WHERE ts.name = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
        LIMIT 1
        """,
    )
    if source_system:
        source_members = fetch_all(
            conn,
            "SELECT strategy_id, is_enabled, weight FROM trading_system_members WHERE system_id = ? ORDER BY id",
            (source_system["system_id"],),
        )
        report["global_card_16_members"] = {
            "system": source_system,
            "members_count": len(source_members),
            "members_enabled": sum(1 for m in source_members if int(m.get("is_enabled") or 0) == 1),
            "strategy_ids": [int(m["strategy_id"]) for m in source_members],
        }

    for c in CLIENTS:
        tenant_id = c["tenant_id"]
        tenant = fetch_one(
            conn,
            """
            SELECT t.id, t.display_name, t.slug, t.assigned_api_key_name,
                   ap.risk_multiplier, ap.requested_enabled, ap.actual_enabled,
                   ap.assigned_api_key_name AS profile_api,
                   ap.execution_api_key_name,
                   ap.published_system_name,
                   ap.updated_at
            FROM tenants t
            JOIN algofund_profiles ap ON ap.tenant_id = t.id
            WHERE t.id = ?
            """,
            (tenant_id,),
        )
        if not tenant:
            report["clients"].append({"tenant_id": tenant_id, "error": "tenant not found"})
            continue

        runtime_system_name = f"ALGOFUND::{tenant['slug']}"
        runtime_system = fetch_one(
            conn,
            """
            SELECT ts.id AS system_id, ts.name, ts.is_active, ak.name AS api_key_name, ts.updated_at
            FROM trading_systems ts
            JOIN api_keys ak ON ak.id = ts.api_key_id
            WHERE ak.name = ? AND ts.name = ?
            LIMIT 1
            """,
            (tenant["execution_api_key_name"], runtime_system_name),
        )

        runtime_members = []
        strategy_ids = []
        if runtime_system:
            runtime_members = fetch_all(
                conn,
                "SELECT strategy_id, is_enabled, weight FROM trading_system_members WHERE system_id = ? ORDER BY id",
                (runtime_system["system_id"],),
            )
            strategy_ids = [int(r["strategy_id"]) for r in runtime_members if r.get("strategy_id") is not None]

        stats_1d = {"entries": 0, "exits": 0, "events": 0}
        stats_7d = {"entries": 0, "exits": 0, "events": 0}
        if strategy_ids:
            placeholders = ",".join("?" for _ in strategy_ids)
            rows_1d = fetch_all(
                conn,
                f"""
                SELECT lower(COALESCE(trade_type,'')) AS trade_type, COUNT(*) AS cnt
                FROM live_trade_events
                WHERE strategy_id IN ({placeholders}) AND COALESCE(actual_time,0) >= ?
                GROUP BY lower(COALESCE(trade_type,''))
                """,
                tuple(strategy_ids) + (d1_ms,),
            )
            rows_7d = fetch_all(
                conn,
                f"""
                SELECT lower(COALESCE(trade_type,'')) AS trade_type, COUNT(*) AS cnt
                FROM live_trade_events
                WHERE strategy_id IN ({placeholders}) AND COALESCE(actual_time,0) >= ?
                GROUP BY lower(COALESCE(trade_type,''))
                """,
                tuple(strategy_ids) + (d7_ms,),
            )
            for row in rows_1d:
                t = row.get("trade_type") or ""
                cnt = int(row.get("cnt") or 0)
                stats_1d["events"] += cnt
                if t == "entry":
                    stats_1d["entries"] += cnt
                if t == "exit":
                    stats_1d["exits"] += cnt
            for row in rows_7d:
                t = row.get("trade_type") or ""
                cnt = int(row.get("cnt") or 0)
                stats_7d["events"] += cnt
                if t == "entry":
                    stats_7d["entries"] += cnt
                if t == "exit":
                    stats_7d["exits"] += cnt

        latest_event = None
        if strategy_ids:
            placeholders = ",".join("?" for _ in strategy_ids)
            lte_cols = {row["name"] for row in fetch_all(conn, "PRAGMA table_info(live_trade_events)")}
            latest_cols = ["strategy_id", "trade_type", "actual_time"]
            for col in ["side", "entry_price", "exit_price", "price", "quantity", "realized_pnl"]:
                if col in lte_cols:
                    latest_cols.append(col)
            latest_event = fetch_one(
                conn,
                f"""
                SELECT {', '.join(latest_cols)}
                FROM live_trade_events
                WHERE strategy_id IN ({placeholders})
                ORDER BY actual_time DESC
                LIMIT 1
                """,
                tuple(strategy_ids),
            )
            if latest_event:
                latest_event["actual_time_utc"] = iso(latest_event.get("actual_time"))

        snap_1d = get_snapshot_delta(conn, tenant["execution_api_key_name"], 24)
        snap_7d = get_snapshot_delta(conn, tenant["execution_api_key_name"], 168)

        report["clients"].append(
            {
                "tenant": tenant,
                "runtime_system": runtime_system,
                "runtime_members_count": len(runtime_members),
                "runtime_members_enabled": sum(1 for m in runtime_members if int(m.get("is_enabled") or 0) == 1),
                "runtime_strategy_ids": strategy_ids,
                "trades_last_1d": stats_1d,
                "trades_last_7d": stats_7d,
                "latest_event": latest_event,
                "snapshot_delta_1d": snap_1d,
                "snapshot_delta_7d": snap_7d,
            }
        )

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
import json
import sqlite3
import time
from datetime import datetime, timezone

DB = "/opt/battletoads-double-dragon/backend/database.db"
RUNTIME_SYSTEMS = [
    {"label": "Ruslan", "systemName": "ALGOFUND::ruslan"},
    {"label": "Ali", "systemName": "ALGOFUND::ali"},
]


def to_iso_ms(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


def fetch_all(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [{cols[i]: row[i] for i in range(len(cols))} for row in cur.fetchall()]


def fetch_one(conn, sql, params=()):
    rows = fetch_all(conn, sql, params)
    return rows[0] if rows else None


def safe_float(value, fallback=0.0):
    try:
        out = float(value)
        return out if out == out else fallback
    except Exception:
        return fallback


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    now_ms = int(time.time() * 1000)
    d1_ms = now_ms - 24 * 3600 * 1000
    d7_ms = now_ms - 7 * 24 * 3600 * 1000

    strategy_cols = {row["name"] for row in fetch_all(conn, "PRAGMA table_info(strategies)")}
    runtime_event_cols = {row["name"] for row in fetch_all(conn, "PRAGMA table_info(strategy_runtime_events)")}

    param_candidates = [
        "interval",
        "length",
        "take_profit_percent",
        "stop_loss_percent",
        "zscore_entry",
        "zscore_exit",
        "zscore_stop",
        "entry_threshold",
        "exit_threshold",
    ]
    existing_param_cols = [c for c in param_candidates if c in strategy_cols]

    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "systems": [],
    }

    for item in RUNTIME_SYSTEMS:
        system_name = item["systemName"]
        system_row = fetch_one(
            conn,
            """
            SELECT ts.id AS system_id, ts.name, ts.is_active, ak.name AS api_key_name
            FROM trading_systems ts
            JOIN api_keys ak ON ak.id = ts.api_key_id
            WHERE ts.name = ?
            LIMIT 1
            """,
            (system_name,),
        )

        if not system_row:
            out["systems"].append({
                "label": item["label"],
                "systemName": system_name,
                "error": "runtime system not found",
            })
            continue

        members = fetch_all(
            conn,
            "SELECT strategy_id, is_enabled, weight FROM trading_system_members WHERE system_id = ? ORDER BY id",
            (system_row["system_id"],),
        )
        strategy_ids = [int(m["strategy_id"]) for m in members if m.get("strategy_id") is not None]

        details = []
        for sid in strategy_ids:
            select_cols = [
                "id",
                "name",
                "base_symbol",
                "quote_symbol",
                "is_active",
                "last_signal",
                "last_action",
                "updated_at",
            ]
            for col in existing_param_cols:
                if col not in select_cols:
                    select_cols.append(col)

            strat = fetch_one(conn, f"SELECT {', '.join(select_cols)} FROM strategies WHERE id = ?", (sid,)) or {}
            pair = f"{strat.get('base_symbol') or ''}/{strat.get('quote_symbol') or ''}".strip("/")

            event_counts = fetch_one(
                conn,
                """
                SELECT
                  SUM(CASE WHEN lower(COALESCE(trade_type,''))='entry' AND actual_time >= ? THEN 1 ELSE 0 END) AS entries_1d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,''))='exit' AND actual_time >= ? THEN 1 ELSE 0 END) AS exits_1d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,''))='entry' AND actual_time >= ? THEN 1 ELSE 0 END) AS entries_7d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,''))='exit' AND actual_time >= ? THEN 1 ELSE 0 END) AS exits_7d,
                  MAX(actual_time) AS last_trade_event_ms
                FROM live_trade_events
                WHERE strategy_id = ?
                """,
                (d1_ms, d1_ms, d7_ms, d7_ms, sid),
            ) or {}

            runtime_event = None
            if "strategy_id" in runtime_event_cols and "created_at" in runtime_event_cols:
                runtime_event = fetch_one(
                    conn,
                    """
                    SELECT event_type, severity, message, created_at
                    FROM strategy_runtime_events
                    WHERE strategy_id = ?
                    ORDER BY created_at DESC
                    LIMIT 1
                    """,
                    (sid,),
                )

            params = {col: strat.get(col) for col in existing_param_cols if strat.get(col) is not None}

            details.append({
                "strategyId": sid,
                "strategyName": strat.get("name"),
                "pair": pair,
                "isActive": int(strat.get("is_active") or 0) == 1,
                "lastSignal": strat.get("last_signal"),
                "lastAction": strat.get("last_action"),
                "strategyUpdatedAt": strat.get("updated_at"),
                "lastTradeEventAt": to_iso_ms(event_counts.get("last_trade_event_ms")),
                "events": {
                    "entries1d": int(event_counts.get("entries_1d") or 0),
                    "exits1d": int(event_counts.get("exits_1d") or 0),
                    "entries7d": int(event_counts.get("entries_7d") or 0),
                    "exits7d": int(event_counts.get("exits_7d") or 0),
                },
                "latestRuntimeEvent": {
                    "type": (runtime_event or {}).get("event_type"),
                    "severity": (runtime_event or {}).get("severity"),
                    "message": (runtime_event or {}).get("message"),
                    "createdAt": to_iso_ms((runtime_event or {}).get("created_at")),
                },
                "entryConditions": params,
            })

        active_count = sum(1 for d in details if d.get("isActive"))
        with_events_1d = sum(1 for d in details if (d.get("events") or {}).get("entries1d", 0) + (d.get("events") or {}).get("exits1d", 0) > 0)
        with_events_7d = sum(1 for d in details if (d.get("events") or {}).get("entries7d", 0) + (d.get("events") or {}).get("exits7d", 0) > 0)

        out["systems"].append({
            "label": item["label"],
            "system": {
                "id": system_row.get("system_id"),
                "name": system_row.get("name"),
                "apiKey": system_row.get("api_key_name"),
                "isActive": int(system_row.get("is_active") or 0) == 1,
            },
            "membersTotal": len(details),
            "membersActive": active_count,
            "membersWithEvents1d": with_events_1d,
            "membersWithEvents7d": with_events_7d,
            "strategies": details,
        })

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

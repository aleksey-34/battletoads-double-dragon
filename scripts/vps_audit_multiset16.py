#!/usr/bin/env python3
import argparse
import json
import sqlite3
import time
from datetime import datetime, timezone


def utc_ms_to_iso(ms):
    if ms is None:
        return None
    try:
        v = int(ms)
    except Exception:
        return None
    if v <= 0:
        return None
    return datetime.fromtimestamp(v / 1000, tz=timezone.utc).isoformat()


def fetch_all(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    rows = []
    for r in cur.fetchall():
        rows.append({cols[i]: r[i] for i in range(len(cols))})
    return rows


def main():
    parser = argparse.ArgumentParser(description="Audit multiset TS clients and trade activity")
    parser.add_argument("--db", default="/opt/battletoads-double-dragon/backend/database.db")
    parser.add_argument("--token", default="ts-multiset-v2-h6e6sh")
    parser.add_argument("--lookback-days", type=int, default=30)
    args = parser.parse_args()

    conn = sqlite3.connect(args.db)
    conn.row_factory = sqlite3.Row

    token_like = f"%{args.token.lower()}%"
    now_ms = int(time.time() * 1000)
    lookback_ms = now_ms - args.lookback_days * 24 * 3600 * 1000

    print("=== SYSTEMS MATCHING TOKEN ===")
    systems = fetch_all(
        conn,
        """
        SELECT
          ts.id AS system_id,
          ts.name,
          ts.api_key_id,
          ak.name AS api_key_name,
          ts.is_active,
          ts.updated_at,
          COUNT(tsm.id) AS members_total,
          COALESCE(SUM(CASE WHEN COALESCE(tsm.is_enabled, 1) = 1 THEN 1 ELSE 0 END), 0) AS members_enabled
        FROM trading_systems ts
        LEFT JOIN api_keys ak ON ak.id = ts.api_key_id
        LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
        WHERE lower(ts.name) LIKE ?
        GROUP BY ts.id, ts.name, ts.api_key_id, ak.name, ts.is_active, ts.updated_at
        ORDER BY ts.id
        """,
        (token_like,),
    )
    print(json.dumps(systems, ensure_ascii=False, indent=2))

    print("=== CLIENTS USING THIS TS (published_system_name LIKE token) ===")
    clients = fetch_all(
        conn,
        """
        SELECT
          t.id AS tenant_id,
          t.display_name,
          t.slug,
          t.assigned_api_key_name AS tenant_api,
          ap.assigned_api_key_name AS profile_api,
          ap.execution_api_key_name AS execution_api,
          ap.requested_enabled,
          ap.actual_enabled,
          ap.published_system_name,
          ap.updated_at
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE t.product_mode = 'algofund_client'
          AND lower(COALESCE(ap.published_system_name, '')) LIKE ?
        ORDER BY t.id
        """,
        (token_like,),
    )
    print(json.dumps(clients, ensure_ascii=False, indent=2))

    print("=== ALGOFUND ACTIVE SYSTEM LINKS (token) ===")
    active_links = fetch_all(
        conn,
        """
        SELECT
            aas.id AS active_id,
            aas.profile_id,
            t.id AS tenant_id,
            t.display_name,
            t.assigned_api_key_name AS tenant_api,
            ap.execution_api_key_name AS execution_api,
            ap.published_system_name,
            aas.system_name,
            aas.is_enabled,
            aas.updated_at
        FROM algofund_active_systems aas
        JOIN algofund_profiles ap ON ap.id = aas.profile_id
        JOIN tenants t ON t.id = ap.tenant_id
        WHERE lower(COALESCE(aas.system_name, '')) LIKE ?
             OR lower(COALESCE(ap.published_system_name, '')) LIKE ?
        ORDER BY t.id, aas.id
        """,
        (token_like, token_like),
    )
    print(json.dumps(active_links, ensure_ascii=False, indent=2))

    print("=== CHECK CLIENT API -> SYSTEM PRESENCE ===")
    client_system_presence = []
    for c in clients:
        system_name = (c.get("published_system_name") or "").strip()
        for api_name in [c.get("execution_api"), c.get("profile_api"), c.get("tenant_api")]:
            if not api_name:
                continue
            rows = fetch_all(
                conn,
                """
                SELECT
                  ts.id AS system_id,
                  ts.name,
                  ak.name AS api_key_name,
                  ts.is_active,
                  COUNT(tsm.id) AS members_total,
                  COALESCE(SUM(CASE WHEN COALESCE(tsm.is_enabled, 1)=1 THEN 1 ELSE 0 END), 0) AS members_enabled
                FROM trading_systems ts
                JOIN api_keys ak ON ak.id = ts.api_key_id
                LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id
                WHERE ak.name = ? AND ts.name = ?
                GROUP BY ts.id, ts.name, ak.name, ts.is_active
                ORDER BY ts.id
                """,
                (api_name, system_name),
            )
            client_system_presence.append(
                {
                    "tenant_id": c.get("tenant_id"),
                    "display_name": c.get("display_name"),
                    "api_name_checked": api_name,
                    "published_system_name": system_name,
                    "systems_found": rows,
                }
            )
    print(json.dumps(client_system_presence, ensure_ascii=False, indent=2))

    print("=== MEMBER STRATEGIES FOR MATCHED SYSTEMS ===")
    member_rows = fetch_all(
        conn,
        """
        SELECT
          ts.id AS system_id,
          ts.name AS system_name,
          ak.name AS api_key_name,
          tsm.strategy_id,
          COALESCE(tsm.is_enabled, 1) AS is_enabled,
          tsm.weight
        FROM trading_systems ts
        LEFT JOIN api_keys ak ON ak.id = ts.api_key_id
        JOIN trading_system_members tsm ON tsm.system_id = ts.id
        WHERE lower(ts.name) LIKE ?
        ORDER BY ts.id, tsm.id
        """,
        (token_like,),
    )
    print(json.dumps(member_rows, ensure_ascii=False, indent=2))

    strategy_ids = sorted({int(r["strategy_id"]) for r in member_rows if r.get("strategy_id") is not None})
    print(f"MEMBER_STRATEGY_IDS_COUNT={len(strategy_ids)}")

    if strategy_ids:
        placeholders = ",".join("?" for _ in strategy_ids)

        print("=== LIVE TRADE EVENTS BY TYPE (ALL TIME) ===")
        all_time = fetch_all(
            conn,
            f"""
            SELECT lower(COALESCE(trade_type, '')) AS trade_type, COUNT(*) AS cnt
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders})
            GROUP BY lower(COALESCE(trade_type, ''))
            ORDER BY cnt DESC
            """,
            tuple(strategy_ids),
        )
        print(json.dumps(all_time, ensure_ascii=False, indent=2))

        print(f"=== LIVE TRADE EVENTS BY TYPE (LAST {args.lookback_days} DAYS) ===")
        lookback = fetch_all(
            conn,
            f"""
            SELECT lower(COALESCE(trade_type, '')) AS trade_type, COUNT(*) AS cnt
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders})
              AND COALESCE(actual_time, 0) >= ?
            GROUP BY lower(COALESCE(trade_type, ''))
            ORDER BY cnt DESC
            """,
            tuple(strategy_ids) + (lookback_ms,),
        )
        print(json.dumps(lookback, ensure_ascii=False, indent=2))

        print("=== STRATEGY-LEVEL LAST EVENT + COUNTS ===")
        strat_stats = fetch_all(
            conn,
            f"""
            SELECT
              strategy_id,
              COUNT(*) AS events_total,
              SUM(CASE WHEN lower(COALESCE(trade_type, ''))='entry' THEN 1 ELSE 0 END) AS entries_total,
              SUM(CASE WHEN lower(COALESCE(trade_type, ''))='exit' THEN 1 ELSE 0 END) AS exits_total,
              SUM(CASE WHEN COALESCE(actual_time, 0) >= ? THEN 1 ELSE 0 END) AS events_lookback,
              MAX(actual_time) AS last_event_ms
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders})
            GROUP BY strategy_id
            ORDER BY events_total DESC, strategy_id ASC
            """,
            (lookback_ms,) + tuple(strategy_ids),
        )
        for row in strat_stats:
            row["last_event_utc"] = utc_ms_to_iso(row.get("last_event_ms"))
        print(json.dumps(strat_stats, ensure_ascii=False, indent=2))

        print("=== RECENT EVENTS SAMPLE ===")
        lte_cols = {r["name"] for r in fetch_all(conn, "PRAGMA table_info(live_trade_events)")}
        select_cols = ["strategy_id", "trade_type", "actual_time"]
        for optional_col in ["symbol", "side", "quantity", "realized_pnl", "price", "entry_price", "exit_price"]:
            if optional_col in lte_cols:
                select_cols.append(optional_col)
        recent = fetch_all(
            conn,
            f"""
            SELECT {', '.join(select_cols)}
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders})
            ORDER BY actual_time DESC
            LIMIT 30
            """,
            tuple(strategy_ids),
        )
        for row in recent:
            row["actual_time_utc"] = utc_ms_to_iso(row.get("actual_time"))
        print(json.dumps(recent, ensure_ascii=False, indent=2))
    else:
        print("No member strategies found for token")

    print("=== LAST SNAPSHOTS FOR CLIENT APIS ===")
    api_names = sorted(
        {
            (c.get("execution_api") or "").strip()
            for c in clients
            if (c.get("execution_api") or "").strip()
        }
    )
    if api_names:
        placeholders = ",".join("?" for _ in api_names)
        snapshots = fetch_all(
            conn,
            f"""
            WITH latest AS (
              SELECT api_key_id, MAX(recorded_at) AS max_recorded
              FROM monitoring_snapshots
              GROUP BY api_key_id
            )
            SELECT
              ak.name AS api_key_name,
              m.recorded_at,
              m.equity_usd,
              m.unrealized_pnl,
              m.margin_load_percent,
              m.drawdown_percent
            FROM monitoring_snapshots m
            JOIN latest l ON l.api_key_id=m.api_key_id AND l.max_recorded=m.recorded_at
            JOIN api_keys ak ON ak.id=m.api_key_id
            WHERE ak.name IN ({placeholders})
            ORDER BY ak.name
            """,
            tuple(api_names),
        )
        print(json.dumps(snapshots, ensure_ascii=False, indent=2))
    else:
        print("No execution api keys found in clients")


if __name__ == "__main__":
    main()

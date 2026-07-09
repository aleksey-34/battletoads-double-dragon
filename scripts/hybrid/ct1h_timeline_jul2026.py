#!/usr/bin/env python3
"""CT 1h timeline + equity path for outlier client."""
from __future__ import annotations

import json
import sqlite3
from datetime import datetime, timedelta, timezone

DB = "/opt/battletoads-double-dragon/backend/database.db"


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    since = int((datetime.now(timezone.utc) - timedelta(hours=72)).timestamp() * 1000)
    out: dict = {}

    out["clientCtIntervals"] = [
        dict(r)
        for r in conn.execute(
            """
            SELECT ts.name, s.interval, COUNT(*) AS n
            FROM trading_systems ts
            JOIN trading_system_members m ON m.system_id = ts.id
            JOIN strategies s ON s.id = m.strategy_id
            JOIN tenants t ON ts.name = 'ALGOFUND::' || t.slug
            JOIN algofund_profiles ap ON ap.tenant_id = t.id
            WHERE s.strategy_type = 'CT_Fractal'
              AND COALESCE(ap.actual_enabled, 0) = 1
            GROUP BY ts.name, s.interval
            ORDER BY ts.name, s.interval
            """
        )
    ]

    rows = []
    for r in conn.execute(
        """
        SELECT a.name AS api,
          MIN(CASE WHEN s.interval='1h' THEN COALESCE(e.actual_time,e.entry_time) END) AS first_1h_ms,
          SUM(CASE WHEN s.interval='1h' AND e.trade_type='entry'
                   AND COALESCE(e.actual_time,e.entry_time)>=? THEN 1 ELSE 0 END) AS e1h_72,
          SUM(CASE WHEN s.interval='4h' AND e.trade_type='entry'
                   AND COALESCE(e.actual_time,e.entry_time)>=? THEN 1 ELSE 0 END) AS e4h_72,
          SUM(CASE WHEN s.interval='1d' AND e.trade_type='entry'
                   AND COALESCE(e.actual_time,e.entry_time)>=? THEN 1 ELSE 0 END) AS e1d_72
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name
        WHERE COALESCE(ap.actual_enabled,0)=1
          AND s.strategy_type='CT_Fractal'
          AND COALESCE(e.event_origin,'exchange_fill')='exchange_fill'
        GROUP BY a.name
        ORDER BY a.name
        """,
        (since, since, since),
    ):
        d = dict(r)
        if d["first_1h_ms"]:
            d["first_1h"] = datetime.fromtimestamp(
                d["first_1h_ms"] / 1000, tz=timezone.utc
            ).isoformat()
        rows.append(d)
    out["ctFillTimeline"] = rows

    out["outlier801"] = [
        dict(r)
        for r in conn.execute(
            """
            SELECT recorded_at, equity_usd, pnl_net_usd, unrealized_pnl, deposit_base_usd
            FROM monitoring_snapshots m
            JOIN api_keys a ON a.id = m.api_key_id
            WHERE a.name = 'artursk-8018546252-api'
            ORDER BY recorded_at DESC
            LIMIT 30
            """
        )
    ]

    out["masterCt"] = [
        dict(r)
        for r in conn.execute(
            """
            SELECT s.id, s.interval, s.base_symbol, s.quote_symbol, s.name
            FROM trading_system_members m
            JOIN trading_systems ts ON ts.id = m.system_id
            JOIN strategies s ON s.id = m.strategy_id
            WHERE ts.name LIKE '%synth-stable-union-v4-4-b3%'
              AND s.strategy_type = 'CT_Fractal'
            ORDER BY s.interval, s.base_symbol
            """
        )
    ]

    # entries per day for LINK/UNI 1h on sample client
    out["linkUniDaily"] = [
        dict(r)
        for r in conn.execute(
            """
            SELECT date(COALESCE(e.actual_time,e.entry_time)/1000, 'unixepoch') AS day,
                   SUM(CASE WHEN e.trade_type='entry' THEN 1 ELSE 0 END) AS entries
            FROM live_trade_events e
            JOIN strategies s ON s.id = e.strategy_id
            JOIN api_keys a ON a.id = s.api_key_id
            WHERE a.name = 'artursk-6323499563-api'
              AND s.strategy_type = 'CT_Fractal'
              AND s.base_symbol = 'LINKUSDT'
              AND COALESCE(e.event_origin,'exchange_fill')='exchange_fill'
              AND COALESCE(e.actual_time,e.entry_time,0) >= ?
            GROUP BY 1
            ORDER BY 1
            """,
            (since,),
        )
    ]

    # runtime errors last 24h
    try:
        out["recentErrors"] = [
            dict(r)
            for r in conn.execute(
                """
                SELECT created_at, level, message
                FROM logs
                WHERE created_at >= datetime('now','-1 day')
                  AND (message LIKE '%Post-open%' OR message LIKE '%109400%'
                       OR message LIKE '%missing leg%' OR message LIKE '%Invalid IP%'
                       OR level = 'error')
                ORDER BY id DESC LIMIT 30
                """
            )
        ]
    except Exception as exc:
        out["logsError"] = str(exc)
        # try bot_logs / system_logs
        for table in ("bot_logs", "system_logs", "app_logs"):
            try:
                cols = [c[1] for c in conn.execute(f"PRAGMA table_info({table})")]
                out[f"{table}_cols"] = cols
            except Exception:
                pass

    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()

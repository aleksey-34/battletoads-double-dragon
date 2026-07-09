#!/usr/bin/env python3
"""Deep live health: equity path, CT by symbol, BingX, drift schema."""
from __future__ import annotations

import json
import os
import sqlite3
from collections import defaultdict
from datetime import datetime, timedelta, timezone

DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
HOURS = int(os.environ.get("HOURS", "72"))


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    since_ms = int((datetime.now(timezone.utc) - timedelta(hours=HOURS)).timestamp() * 1000)
    out: dict = {"hours": HOURS}

    equity = []
    for r in conn.execute(
        """
        SELECT a.name, a.exchange,
          (SELECT equity_usd FROM monitoring_snapshots m
           WHERE m.api_key_id=a.id AND m.recorded_at>=datetime('now', ?)
           ORDER BY m.recorded_at ASC LIMIT 1) AS first_eq,
          (SELECT equity_usd FROM monitoring_snapshots m
           WHERE m.api_key_id=a.id
           ORDER BY m.recorded_at DESC LIMIT 1) AS last_eq,
          (SELECT pnl_net_usd FROM monitoring_snapshots m
           WHERE m.api_key_id=a.id
           ORDER BY m.recorded_at DESC LIMIT 1) AS pnl_net,
          (SELECT recorded_at FROM monitoring_snapshots m
           WHERE m.api_key_id=a.id
           ORDER BY m.recorded_at DESC LIMIT 1) AS last_at
        FROM api_keys a
        JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name
        WHERE COALESCE(ap.actual_enabled, 0) = 1
        ORDER BY a.exchange, a.name
        """,
        (f"-{HOURS // 24 + 1} days",),
    ):
        fe, le = r["first_eq"], r["last_eq"]
        d = (le - fe) if fe is not None and le is not None else None
        pct = (100.0 * d / fe) if d is not None and fe else None
        equity.append(
            {
                "api": r["name"],
                "exchange": r["exchange"],
                "first": fe,
                "last": le,
                "delta": None if d is None else round(d, 2),
                "pct": None if pct is None else round(pct, 2),
                "pnlNet": r["pnl_net"],
                "lastAt": r["last_at"],
            }
        )
    out["equity"] = equity

    out["lteCols"] = [c[1] for c in conn.execute("PRAGMA table_info(live_trade_events)")]
    try:
        out["driftCols"] = [c[1] for c in conn.execute("PRAGMA table_info(drift_alerts)")]
        out["driftRecent"] = [
            dict(r)
            for r in conn.execute(
                """
                SELECT d.id, d.strategy_id, d.metric_name, d.severity, d.value,
                       d.threshold, d.drift_percent, d.description, d.created_at,
                       s.name AS strategy_name, s.strategy_type
                FROM drift_alerts d
                LEFT JOIN strategies s ON s.id = d.strategy_id
                ORDER BY d.id DESC LIMIT 20
                """
            )
        ]
        out["driftAgg"] = [
            dict(r)
            for r in conn.execute(
                """
                SELECT metric_name, severity, COUNT(*) AS n
                FROM drift_alerts
                WHERE created_at >= ?
                GROUP BY 1, 2
                ORDER BY n DESC
                """,
                (since_ms,),
            )
        ]
    except Exception as exc:
        out["driftError"] = str(exc)

    api = os.environ.get("SAMPLE_API", "artursk-6323499563-api")
    legs = []
    for r in conn.execute(
        """
        SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval,
          SUM(CASE WHEN e.trade_type='entry' THEN 1 ELSE 0 END) AS entries,
          SUM(CASE WHEN e.trade_type='exit' THEN 1 ELSE 0 END) AS exits
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE a.name = ?
          AND s.strategy_type = 'CT_Fractal'
          AND COALESCE(e.event_origin, 'exchange_fill') = 'exchange_fill'
          AND COALESCE(e.actual_time, e.entry_time, 0) >= ?
        GROUP BY s.id
        ORDER BY entries DESC
        """,
        (api, since_ms),
    ):
        legs.append(dict(r))
    out["ctLegsSample"] = {"api": api, "legs": legs}

    # FIFO PnL per CT symbol (mono only — synth pairs need dual-leg accounting)
    openp: dict[int, list] = defaultdict(list)
    closed_by_sym: dict[str, dict] = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0})
    for e in conn.execute(
        """
        SELECT e.strategy_id, e.trade_type, e.side, e.actual_price, e.position_size,
               e.actual_fee, s.base_symbol, s.quote_symbol, s.interval
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE a.name = ?
          AND s.strategy_type = 'CT_Fractal'
          AND COALESCE(e.event_origin, 'exchange_fill') = 'exchange_fill'
          AND COALESCE(e.actual_time, e.entry_time, 0) >= ?
        ORDER BY COALESCE(e.actual_time, e.entry_time), e.id
        """,
        (api, since_ms),
    ):
        sid = int(e["strategy_id"])
        sym = f"{e['base_symbol']}/{e['quote_symbol'] or '-'}:{e['interval']}"
        px = float(e["actual_price"] or 0)
        qty = abs(float(e["position_size"] or 0))
        fee = float(e["actual_fee"] or 0)
        if e["trade_type"] == "entry":
            openp[sid].append([px, qty, fee, e["side"], sym])
        else:
            rem = qty
            while rem > 1e-9 and openp[sid]:
                ep, eq, ef, side, ssym = openp[sid][0]
                take = min(rem, eq)
                pnl = (px - ep) * take if side == "long" else (ep - px) * take
                pnl -= fee * (take / qty if qty else 0) + ef * (take / eq if eq else 0)
                b = closed_by_sym[ssym]
                b["n"] += 1
                b["pnl"] += pnl
                if pnl > 0:
                    b["wins"] += 1
                rem -= take
                eq -= take
                if eq <= 1e-9:
                    openp[sid].pop(0)
                else:
                    openp[sid][0][1] = eq
    out["ctPnlBySymNaive"] = {
        k: {
            "n": v["n"],
            "wins": v["wins"],
            "wr": round(100 * v["wins"] / max(1, v["n"]), 1),
            "pnl": round(v["pnl"], 2),
            "note": "naive single-leg; synth pairs overstate loss",
        }
        for k, v in sorted(closed_by_sym.items(), key=lambda x: x[1]["pnl"])
    }

    bingx = []
    for r in conn.execute(
        """
        SELECT a.name,
          COUNT(*) AS n,
          MAX(COALESCE(e.actual_time, e.entry_time)) AS last_ms
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE LOWER(COALESCE(a.exchange,'')) = 'bingx'
          AND COALESCE(e.event_origin, 'exchange_fill') = 'exchange_fill'
          AND COALESCE(e.actual_time, e.entry_time, 0) >= ?
        GROUP BY a.name
        """,
        (int((datetime.now(timezone.utc) - timedelta(days=7)).timestamp() * 1000),),
    ):
        bingx.append(dict(r))
    out["bingxFills7d"] = bingx

    # runtime errors last hours from journal? skip — use bot_logs if exists
    try:
        out["botLogCols"] = [c[1] for c in conn.execute("PRAGMA table_info(bot_logs)")]
    except Exception as exc:
        out["botLogCols"] = str(exc)

    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()

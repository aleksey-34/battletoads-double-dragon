#!/usr/bin/env python3
"""Fleet live health: fills, winrate, drift alerts, composition vs master."""
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
    now = datetime.now(timezone.utc)
    since_ms = int((now - timedelta(hours=HOURS)).timestamp() * 1000)
    out: dict = {"hours": HOURS, "generatedAt": now.isoformat()}

    # drift alerts
    try:
        drifts = conn.execute(
            """
            SELECT severity, alert_type, COUNT(*) n
            FROM drift_alerts
            WHERE created_at >= datetime('now', ?)
            GROUP BY 1, 2
            ORDER BY n DESC
            """,
            (f"-{HOURS} hours",),
        ).fetchall()
        out["driftAlerts"] = [dict(r) for r in drifts]
        recent = conn.execute(
            """
            SELECT id, severity, alert_type, message, created_at
            FROM drift_alerts
            WHERE created_at >= datetime('now', ?)
            ORDER BY id DESC LIMIT 15
            """,
            (f"-{HOURS} hours",),
        ).fetchall()
        out["driftRecent"] = [dict(r) for r in recent]
    except Exception as exc:
        out["driftAlerts"] = {"error": str(exc)}

    # enabled clients
    clients = conn.execute(
        """
        SELECT t.slug, ap.execution_api_key_name AS api, ap.published_system_name AS sys,
               ap.actual_enabled, a.exchange
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        LEFT JOIN api_keys a ON a.name = ap.execution_api_key_name
        WHERE COALESCE(ap.actual_enabled, 0) = 1
        ORDER BY t.slug
        """
    ).fetchall()
    out["enabledClients"] = [dict(r) for r in clients]

    # fills by api + type
    fills = conn.execute(
        """
        SELECT a.name AS api, a.exchange, s.strategy_type AS stype,
               COALESCE(s.interval, '?') AS iv,
               SUM(CASE WHEN e.trade_type='entry' THEN 1 ELSE 0 END) AS entries,
               SUM(CASE WHEN e.trade_type='exit' THEN 1 ELSE 0 END) AS exits,
               COUNT(*) AS events
        FROM live_trade_events e
        JOIN strategies s ON s.id = e.strategy_id
        JOIN api_keys a ON a.id = s.api_key_id
        WHERE COALESCE(e.event_origin, 'exchange_fill') = 'exchange_fill'
          AND COALESCE(e.actual_time, e.entry_time, 0) >= ?
          AND a.name IN (
            SELECT execution_api_key_name FROM algofund_profiles
            WHERE COALESCE(actual_enabled,0)=1 AND execution_api_key_name IS NOT NULL
          )
        GROUP BY 1,2,3,4
        ORDER BY entries DESC
        """,
        (since_ms,),
    ).fetchall()
    out["fillsByApiType"] = [dict(r) for r in fills]

    # per-client totals
    by_api: dict[str, dict] = defaultdict(lambda: {"entries": 0, "exits": 0, "byType": {}})
    for r in fills:
        d = by_api[r["api"]]
        d["entries"] += int(r["entries"] or 0)
        d["exits"] += int(r["exits"] or 0)
        d["exchange"] = r["exchange"]
        d["byType"][f"{r['stype']}:{r['iv']}"] = {
            "entries": int(r["entries"] or 0),
            "exits": int(r["exits"] or 0),
        }
    out["fillsByApi"] = dict(by_api)

    # closed PnL sample for WEEX clients (FIFO per strategy_id)
    sample_apis = [
        r["api"] for r in clients if r["api"] and str(r["exchange"] or "").lower() == "weex"
    ][:3]
    pnl_out = {}
    for api in sample_apis:
        ev = conn.execute(
            """
            SELECT e.strategy_id, e.trade_type, e.side, e.actual_price, e.position_size,
                   e.actual_fee, s.strategy_type, s.base_symbol, s.quote_symbol, s.interval
            FROM live_trade_events e
            JOIN strategies s ON s.id = e.strategy_id
            JOIN api_keys a ON a.id = s.api_key_id
            WHERE a.name = ?
              AND COALESCE(e.event_origin, 'exchange_fill') = 'exchange_fill'
              AND COALESCE(e.actual_time, e.entry_time, 0) >= ?
            ORDER BY COALESCE(e.actual_time, e.entry_time), e.id
            """,
            (api, since_ms),
        ).fetchall()
        openp: dict[int, list] = defaultdict(list)
        closed = []
        for e in ev:
            sid = int(e["strategy_id"])
            px = float(e["actual_price"] or 0)
            qty = abs(float(e["position_size"] or 0))
            fee = float(e["actual_fee"] or 0)
            if e["trade_type"] == "entry":
                openp[sid].append([px, qty, fee, e["side"], e["strategy_type"], e["interval"]])
            else:
                rem = qty
                while rem > 1e-9 and openp[sid]:
                    ep, eq, ef, side, st, iv = openp[sid][0]
                    take = min(rem, eq)
                    if side == "long":
                        pnl = (px - ep) * take
                    else:
                        pnl = (ep - px) * take
                    fee_part = fee * (take / qty if qty else 0) + ef * (take / eq if eq else 0)
                    pnl -= fee_part
                    closed.append({"stype": st, "iv": iv, "pnl": pnl, "side": side})
                    rem -= take
                    eq -= take
                    if eq <= 1e-9:
                        openp[sid].pop(0)
                    else:
                        openp[sid][0][1] = eq
        by = defaultdict(lambda: {"n": 0, "wins": 0, "pnl": 0.0})
        for c in closed:
            b = by[c["stype"]]
            b["n"] += 1
            b["pnl"] += c["pnl"]
            if c["pnl"] > 0:
                b["wins"] += 1
        pnl_out[api] = {
            "closed": len(closed),
            "byType": {
                k: {
                    "n": v["n"],
                    "wins": v["wins"],
                    "wr": round(100 * v["wins"] / max(1, v["n"]), 1),
                    "pnl": round(v["pnl"], 2),
                }
                for k, v in by.items()
            },
            "worst5": sorted(closed, key=lambda x: x["pnl"])[:5],
        }
    out["pnlSample"] = pnl_out

    # composition: master B3 vs one client
    master = conn.execute(
        """
        SELECT s.strategy_type, s.interval, COUNT(*) n
        FROM trading_system_members m
        JOIN trading_systems ts ON ts.id = m.system_id
        JOIN strategies s ON s.id = m.strategy_id
        WHERE ts.name LIKE '%synth-stable-union-v4-4-b3%'
        GROUP BY 1,2 ORDER BY 1,2
        """
    ).fetchall()
    out["masterComposition"] = [dict(r) for r in master]

    if clients:
        slug = clients[0]["slug"]
        client_comp = conn.execute(
            """
            SELECT s.strategy_type, s.interval, COUNT(*) n
            FROM trading_system_members m
            JOIN trading_systems ts ON ts.id = m.system_id
            JOIN strategies s ON s.id = m.strategy_id
            WHERE ts.name = ?
            GROUP BY 1,2 ORDER BY 1,2
            """,
            (f"ALGOFUND::{slug}",),
        ).fetchall()
        out["sampleClientComposition"] = {"slug": slug, "legs": [dict(r) for r in client_comp]}

    # CT still on 4h among live clients
    leftover = conn.execute(
        """
        SELECT ts.name, COUNT(*) n
        FROM strategies s
        JOIN trading_system_members m ON m.strategy_id = s.id
        JOIN trading_systems ts ON ts.id = m.system_id
        WHERE ts.name LIKE 'ALGOFUND::%'
          AND s.strategy_type = 'CT_Fractal'
          AND s.interval = '4h'
        GROUP BY 1
        """
    ).fetchall()
    out["liveCtStill4h"] = [dict(r) for r in leftover]

    print(json.dumps(out, indent=2, ensure_ascii=False, default=str))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Live activity / margin / idle tables for enabled artursk clients (VPS DB)."""
from __future__ import annotations

import json
import sqlite3
import sys
from datetime import datetime, timezone, timedelta

DB = sys.argv[1] if len(sys.argv) > 1 else "/opt/battletoads-double-dragon/backend/database.db"


def main() -> None:
    db = sqlite3.connect(DB)
    db.row_factory = sqlite3.Row
    now = datetime.now(timezone.utc)
    cut3 = int((now - timedelta(days=3)).timestamp() * 1000)
    cut7 = int((now - timedelta(days=7)).timestamp() * 1000)

    print("=== COMPOSITION (active+auto artursk) ===")
    rows = db.execute(
        """
        SELECT a.name AS api, a.exchange,
          SUM(CASE WHEN s.strategy_type='momentum_scalp_tv' THEN 1 ELSE 0 END) AS mom,
          SUM(CASE WHEN s.strategy_type='CT_Fractal' AND s.interval='4h' THEN 1 ELSE 0 END) AS ct4h,
          SUM(CASE WHEN s.strategy_type='CT_Fractal' AND s.interval='1d' THEN 1 ELSE 0 END) AS ct1d,
          SUM(CASE WHEN s.strategy_type='DD_BattleToads' THEN 1 ELSE 0 END) AS dd,
          SUM(CASE WHEN s.strategy_type NOT IN ('momentum_scalp_tv','CT_Fractal','DD_BattleToads') THEN 1 ELSE 0 END) AS other
        FROM strategies s
        JOIN api_keys a ON a.id=s.api_key_id
        WHERE s.is_active=1 AND s.auto_update=1 AND a.name LIKE 'artursk-%'
        GROUP BY a.name
        ORDER BY a.name
        """
    ).fetchall()
    print(f"{'api':32} {'ex':6} {'mom':>4} {'ct4h':>4} {'ct1d':>4} {'dd':>3} {'oth':>3}")
    for r in rows:
        print(f"{r['api']:32} {r['exchange']:6} {r['mom']:4} {r['ct4h']:4} {r['ct1d']:4} {r['dd']:3} {r['other']:3}")

    print("\n=== TRUE strategy_signal vs exchange_fill entries (7d) ===")
    print(f"{'type':20} {'sig_entry':>9} {'fill_entry':>10}")
    for r in db.execute(
        """
        SELECT s.strategy_type AS t,
          SUM(CASE WHEN e.event_origin='strategy_signal' AND e.trade_type='entry' THEN 1 ELSE 0 END) AS sig,
          SUM(CASE WHEN e.event_origin='exchange_fill' AND e.trade_type='entry' THEN 1 ELSE 0 END) AS fill
        FROM live_trade_events e
        JOIN strategies s ON s.id=e.strategy_id
        WHERE e.actual_time>=?
        GROUP BY 1 ORDER BY 1
        """,
        (cut7,),
    ):
        print(f"{r['t']:20} {r['sig']:9} {r['fill']:10}")

    print("\n=== CT_Fractal activity by pair (3d, strategy_signal entries) ===")
    print(f"{'pair':28} {'iv':4} {'sig':>5} {'fills':>6}")
    for r in db.execute(
        """
        SELECT s.base_symbol||'/'||COALESCE(NULLIF(s.quote_symbol,''),'-') AS pair,
               s.interval AS iv,
               SUM(CASE WHEN e.trade_type='entry' AND e.event_origin='strategy_signal' THEN 1 ELSE 0 END) AS sig,
               SUM(CASE WHEN e.trade_type='entry' AND e.event_origin='exchange_fill' THEN 1 ELSE 0 END) AS fills
        FROM live_trade_events e
        JOIN strategies s ON s.id=e.strategy_id
        WHERE s.strategy_type='CT_Fractal' AND e.actual_time>=?
        GROUP BY 1,2
        ORDER BY fills DESC
        LIMIT 20
        """,
        (cut3,),
    ):
        print(f"{r['pair']:28} {r['iv']:4} {r['sig']:5} {r['fills']:6}")

    print("\n=== Momentum: strategy_signal entries by day (7d) — expect 0 while ADX bug live ===")
    for r in db.execute(
        """
        SELECT date(e.actual_time/1000,'unixepoch') AS d, COUNT(*) AS n
        FROM live_trade_events e
        JOIN strategies s ON s.id=e.strategy_id
        WHERE s.strategy_type='momentum_scalp_tv'
          AND e.event_origin='strategy_signal'
          AND e.trade_type='entry'
          AND e.actual_time>=?
        GROUP BY 1 ORDER BY 1
        """,
        (cut7,),
    ):
        print(dict(r))
    n = db.execute(
        """
        SELECT COUNT(*) FROM live_trade_events e
        JOIN strategies s ON s.id=e.strategy_id
        WHERE s.strategy_type='momentum_scalp_tv'
          AND e.event_origin='strategy_signal' AND e.actual_time>=?
        """,
        (cut7,),
    ).fetchone()[0]
    print(f"total momentum strategy_signal events 7d: {n}")

    cols = [c[1] for c in db.execute("PRAGMA table_info(monitoring_snapshots)").fetchall()]
    print("\n=== monitoring_snapshots columns ===")
    print(", ".join(cols))

    # Best-effort margin / equity from whatever columns exist
    eq_col = next((c for c in ("equity_usd", "equity", "total_equity", "balance", "wallet_balance") if c in cols), None)
    margin_col = next(
        (c for c in ("margin_load_percent", "margin_used_pct", "margin_ratio", "used_margin_pct", "margin_pct") if c in cols),
        None,
    )
    lev_col = next((c for c in ("effective_leverage", "leverage", "position_leverage") if c in cols), None)
    ts_col = next((c for c in ("recorded_at", "created_at", "ts", "timestamp") if c in cols), None)
    key_col = next((c for c in ("api_key_id", "api_key_name") if c in cols), None)
    dd_col = next((c for c in ("drawdown_percent",) if c in cols), None)

    if eq_col and ts_col and key_col:
        print(f"\n=== Equity / margin 72h (cols: {eq_col}, {margin_col}, {lev_col}) ===")
        join = "JOIN api_keys a ON a.id=m.api_key_id" if key_col == "api_key_id" else "JOIN api_keys a ON a.name=m.api_key_name"
        margin_sel = f"ROUND(MAX(m.{margin_col}),2)" if margin_col else "NULL"
        lev_sel = f"ROUND(MAX(m.{lev_col}),2)" if lev_col else "NULL"
        q = f"""
        SELECT a.name AS api, a.exchange,
          ROUND(MIN(m.{eq_col}),2) AS min_eq,
          ROUND(MAX(m.{eq_col}),2) AS max_eq,
          ROUND(100.0*(MIN(m.{eq_col})-MAX(m.{eq_col}))/NULLIF(MAX(m.{eq_col}),0),2) AS worst_vs_peak_pct,
          {margin_sel} AS max_margin,
          {lev_sel} AS max_lev
        FROM monitoring_snapshots m
        {join}
        WHERE m.{ts_col}>=? AND a.name LIKE 'artursk-%'
        GROUP BY a.name
        ORDER BY a.name
        """
        print(f"{'api':32} {'ex':6} {'min_eq':>10} {'max_eq':>10} {'vsPeak%':>8} {'mgn%':>6} {'lev':>5}")
        for r in db.execute(q, (cut3,)):
            print(
                f"{r['api']:32} {r['exchange']:6} {r['min_eq']:10} {r['max_eq']:10} "
                f"{r['worst_vs_peak_pct']:8} {str(r['max_margin']):>6} {str(r['max_lev']):>5}"
            )

    print("\n=== Fake momentum fills: hold seconds (exchange_fill only, 3d) ===")
    for r in db.execute(
        """
        SELECT
          CASE
            WHEN (ex.actual_time-en.actual_time)<60000 THEN '<1m'
            WHEN (ex.actual_time-en.actual_time)<300000 THEN '1-5m'
            WHEN (ex.actual_time-en.actual_time)<900000 THEN '5-15m'
            ELSE '>15m'
          END AS bucket,
          COUNT(*) AS n
        FROM live_trade_events en
        JOIN live_trade_events ex ON ex.strategy_id=en.strategy_id AND ex.trade_type='exit' AND ex.id>en.id
        JOIN strategies s ON s.id=en.strategy_id
        WHERE s.strategy_type='momentum_scalp_tv' AND en.trade_type='entry'
          AND en.event_origin='exchange_fill'
          AND en.actual_time>=?
          AND NOT EXISTS (
            SELECT 1 FROM live_trade_events m
            WHERE m.strategy_id=en.strategy_id AND m.id>en.id AND m.id<ex.id
          )
        GROUP BY 1 ORDER BY 1
        """,
        (cut3,),
    ):
        print(dict(r))

    out = {
        "generatedAt": now.isoformat(),
        "note": (
            "momentum_scalp_tv has 0 strategy_signal while ADX last-bar was NaN; "
            "exchange_fill rows on momentum strategies are mostly CT/other legs mis-attributed by symbol sync."
        ),
    }
    print("\n" + json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

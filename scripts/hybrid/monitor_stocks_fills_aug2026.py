#!/usr/bin/env python3
"""Monitor WEEX stock sleeve fills/signals since a cutoff."""
from __future__ import annotations

import datetime
import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = (
    os.environ.get("BTDD_DB_PATH")
    or os.environ.get("DB_FILE")
    or str(ROOT / "backend" / "database.db")
)
STOCKS = "MUUSDT SOXLUSDT IBMUSDT AMZNUSDT INTCUSDT TSLAUSDT RIVNUSDT BABAUSDT".split()
since = os.environ.get("SINCE") or "2026-08-09 17:40:00"
ms = int(datetime.datetime.fromisoformat(since.replace(" ", "T")).timestamp() * 1000)
ph = ",".join("?" * len(STOCKS))

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
print("db", DB)
print("since", since)
print(
    "fills",
    [
        dict(r)
        for r in c.execute(
            f"""
 SELECT a.name, s.base_symbol, lte.trade_type, lte.side,
        datetime(lte.actual_time/1000,'unixepoch') t, lte.actual_price
 FROM live_trade_events lte
 JOIN strategies s ON s.id=lte.strategy_id
 JOIN api_keys a ON a.id=s.api_key_id
 WHERE s.base_symbol IN ({ph})
   AND lte.event_origin='exchange_fill' AND lte.actual_time>=?
 ORDER BY lte.actual_time DESC LIMIT 50
""",
            (*STOCKS, ms),
        )
    ],
)
print(
    "signals",
    [
        dict(r)
        for r in c.execute(
            f"""
 SELECT a.name, COUNT(*) n FROM live_trade_events lte
 JOIN strategies s ON s.id=lte.strategy_id JOIN api_keys a ON a.id=s.api_key_id
 WHERE s.base_symbol IN ({ph}) AND lte.actual_time>=?
 GROUP BY a.name ORDER BY n DESC
""",
            (*STOCKS, ms),
        )
    ],
)
print(
    "last_action",
    [
        dict(r)
        for r in c.execute(
            f"""
 SELECT a.name, s.base_symbol, s.last_action FROM strategies s
 JOIN api_keys a ON a.id=s.api_key_id
 WHERE a.name IN ('arcopy1','icopy1-api','Copy_Alex1')
   AND s.base_symbol IN ({ph})
 ORDER BY a.name, s.base_symbol
""",
            STOCKS,
        )
    ][:24],
)
print(
    "empty_mrs2_active",
    c.execute(
        """
 SELECT COUNT(*) FROM strategies
 WHERE strategy_type IN ('MeanReversion','MeanReversionScalp2')
   AND COALESCE(is_active,1)=1
   AND (mrs2_config_json IS NULL OR mrs2_config_json='' OR mrs2_config_json='{}')
"""
    ).fetchone()[0],
)

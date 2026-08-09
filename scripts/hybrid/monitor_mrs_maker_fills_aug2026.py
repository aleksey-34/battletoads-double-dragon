#!/usr/bin/env python3
"""Forward monitor: MRS mono maker vs taker exchange fills (post is_maker column)."""
from __future__ import annotations

import os
import sqlite3
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
DB = os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE") or str(ROOT / "backend" / "database.db")
KEYS = [k.strip() for k in (os.environ.get("KEYS") or "arcopy1,icopy1-api,Copy_Alex1").split(",") if k.strip()]
since = os.environ.get("SINCE") or "2026-08-09 17:40:00"

c = sqlite3.connect(DB)
c.row_factory = sqlite3.Row
print("db", DB)
print("keys", KEYS)
print("since", since)

# column may be missing before migrate
cols = {r[1] for r in c.execute("PRAGMA table_info(live_trade_events)")}
has_maker = "is_maker" in cols
print("has_is_maker", has_maker)

q = f"""
SELECT a.name,
       COUNT(*) fills,
       SUM(CASE WHEN COALESCE(lte.is_maker,0)=1 THEN 1 ELSE 0 END) maker,
       SUM(CASE WHEN COALESCE(lte.is_maker,0)=0 THEN 1 ELSE 0 END) taker_or_unknown
FROM live_trade_events lte
JOIN strategies s ON s.id=lte.strategy_id
JOIN api_keys a ON a.id=s.api_key_id
WHERE a.name IN ({",".join("?"*len(KEYS))})
  AND s.strategy_type IN ('MeanReversion','MRS2')
  AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
  AND lte.actual_time >= CAST(strftime('%s', ?) AS INTEGER)*1000
GROUP BY a.name
ORDER BY a.name
""" if has_maker else f"""
SELECT a.name, COUNT(*) fills, NULL maker, NULL taker_or_unknown
FROM live_trade_events lte
JOIN strategies s ON s.id=lte.strategy_id
JOIN api_keys a ON a.id=s.api_key_id
WHERE a.name IN ({",".join("?"*len(KEYS))})
  AND s.strategy_type IN ('MeanReversion','MRS2')
  AND COALESCE(lte.event_origin,'exchange_fill')='exchange_fill'
  AND lte.actual_time >= CAST(strftime('%s', ?) AS INTEGER)*1000
GROUP BY a.name
ORDER BY a.name
"""
print("mrs_fills", [dict(r) for r in c.execute(q, (*KEYS, since))])

print("recent_maker", [dict(r) for r in c.execute(f"""
SELECT a.name, s.base_symbol, lte.trade_type, lte.side, lte.is_maker,
       datetime(lte.actual_time/1000,'unixepoch') t, lte.actual_price, lte.actual_fee
FROM live_trade_events lte
JOIN strategies s ON s.id=lte.strategy_id
JOIN api_keys a ON a.id=s.api_key_id
WHERE a.name IN ({",".join("?"*len(KEYS))})
  AND s.strategy_type IN ('MeanReversion','MRS2')
  AND COALESCE(lte.is_maker,0)=1
ORDER BY lte.actual_time DESC LIMIT 20
""", KEYS)] if has_maker else [])

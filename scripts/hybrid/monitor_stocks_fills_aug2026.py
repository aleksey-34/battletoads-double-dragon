#!/usr/bin/env python3
"""Monitor WEEX stock sleeve fills/signals since a cutoff."""
import os, sqlite3, datetime, json
DB=os.environ.get("BTDD_DB_PATH") or os.environ.get("DB_FILE")
STOCKS="MUUSDT SOXLUSDT IBMUSDT AMZNUSDT INTCUSDT TSLAUSDT RIVNUSDT BABAUSDT".split()
since=os.environ.get("SINCE") or "2026-08-09 17:40:00"
ms=int(datetime.datetime.fromisoformat(since.replace(" ","T")).timestamp()*1000)
c=sqlite3.connect(DB); c.row_factory=sqlite3.Row
print("since", since)
print("fills", [dict(r) for r in c.execute(f"""
 SELECT a.name, s.base_symbol, lte.trade_type, lte.side,
        datetime(lte.actual_time/1000,'unixepoch') t, lte.actual_price
 FROM live_trade_events lte
 JOIN strategies s ON s.id=lte.strategy_id
 JOIN api_keys a ON a.id=s.api_key_id
 WHERE s.base_symbol IN ({",".join("?"*len(STOCKS))})
   AND lte.event_origin='exchange_fill' AND lte.actual_time>=?
 ORDER BY lte.actual_time DESC LIMIT 50
""", (*STOCKS, ms))])
print("signals", [dict(r) for r in c.execute(f"""
 SELECT a.name, COUNT(*) n FROM live_trade_events lte
 JOIN strategies s ON s.id=lte.strategy_id JOIN api_keys a ON a.id=s.api_key_id
 WHERE s.base_symbol IN ({",".join("?"*len(STOCKS))}) AND lte.actual_time>=?
 GROUP BY a.name ORDER BY n DESC
""", (*STOCKS, ms))])
print("last_action", [dict(r) for r in c.execute(f"""
 SELECT a.name, s.base_symbol, s.last_action FROM strategies s
 JOIN api_keys a ON a.id=s.api_key_id
 WHERE a.name IN ('arcopy1','icopy1-api','Copy_Alex1')
   AND s.base_symbol IN ({",".join("?"*len(STOCKS))})
 ORDER BY a.name, s.base_symbol
""", STOCKS)][:24])

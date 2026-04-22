#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timedelta

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
API_KEYS = ["HDB_15", "HDB_18", "ivan_weex_1"]

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

cols = [r[1] for r in cur.execute("PRAGMA table_info(live_trade_events)").fetchall()]

# Determine timestamp column
ts_col = "created_at" if "created_at" in cols else ("event_time" if "event_time" in cols else None)
if not ts_col:
    raise RuntimeError("live_trade_events has no created_at/event_time column")

# Determine pnl column if present
pnl_col = None
for candidate in ["pnl", "realized_pnl", "pnl_usdt", "profit", "net_pnl"]:
    if candidate in cols:
        pnl_col = candidate
        break

# Determine exit marker column
event_col = "event_type" if "event_type" in cols else ("event" if "event" in cols else None)

api_map = {
    r["name"]: int(r["id"])
    for r in cur.execute("SELECT id,name FROM api_keys WHERE name IN (%s)" % ",".join("?" for _ in API_KEYS), API_KEYS).fetchall()
}

api_filter_col = "api_key_id" if "api_key_id" in cols else ("api_key_name" if "api_key_name" in cols else None)
if not api_filter_col:
    raise RuntimeError("live_trade_events has no api_key_id/api_key_name column")


def parse_dt(s):
    if not s:
        return None
    txt = str(s).replace("T", " ").replace("Z", "").strip()
    for fmt in ["%Y-%m-%d %H:%M:%S.%f", "%Y-%m-%d %H:%M:%S"]:
        try:
            return datetime.strptime(txt, fmt)
        except Exception:
            pass
    return None


def event_pnl(row):
    if pnl_col and row[pnl_col] is not None:
        try:
            return float(row[pnl_col])
        except Exception:
            return 0.0

    # Fallback: estimate pnl only for exit events if price fields exist
    if event_col:
        ev = str(row[event_col] or "").lower()
        if "exit" not in ev and "close" not in ev:
            return 0.0

    if "entry_price" in row.keys() and "exit_price" in row.keys() and "qty" in row.keys():
        try:
            ep = float(row["entry_price"] or 0)
            xp = float(row["exit_price"] or 0)
            qty = float(row["qty"] or 0)
            side = str(row["side"] or "long").lower()
            if ep <= 0 or xp <= 0 or qty == 0:
                return 0.0
            direction = 1.0 if side in ("long", "buy") else -1.0
            return (xp - ep) * qty * direction
        except Exception:
            return 0.0

    return 0.0


now = datetime.utcnow()
windows = {
    "1d": now - timedelta(days=1),
    "7d": now - timedelta(days=7),
    "30d": now - timedelta(days=30),
}

result = {
    "schema": {
        "timestampColumn": ts_col,
        "pnlColumn": pnl_col,
        "eventColumn": event_col,
        "columns": cols,
    },
    "systems": [],
}

for key in API_KEYS:
    api_id = api_map.get(key)
    if not api_id and api_filter_col == "api_key_id":
        result["systems"].append({"apiKeyName": key, "error": "api_key_not_found"})
        continue

    where_val = api_id if api_filter_col == "api_key_id" else key
    rows = [
        dict(r)
        for r in cur.execute(
            f"SELECT * FROM live_trade_events WHERE {api_filter_col} = ? ORDER BY {ts_col} DESC LIMIT 50000",
            (where_val,),
        ).fetchall()
    ]

    # parse timestamps once
    prepared = []
    for r in rows:
        dt = parse_dt(r.get(ts_col))
        if not dt:
            continue
        prepared.append((dt, r))

    windows_data = {}
    for label, start in windows.items():
        subset = [r for dt, r in prepared if dt >= start]
        pnls = [event_pnl(r) for r in subset]
        wins = sum(1 for p in pnls if p > 0)
        losses = sum(1 for p in pnls if p < 0)
        total = len(pnls)
        gross_profit = sum(p for p in pnls if p > 0)
        gross_loss = abs(sum(p for p in pnls if p < 0))
        net = sum(pnls)
        pf = (gross_profit / gross_loss) if gross_loss > 1e-9 else (999.0 if gross_profit > 0 else 0.0)
        wr = (wins / total * 100.0) if total > 0 else 0.0
        windows_data[label] = {
            "events": total,
            "wins": wins,
            "losses": losses,
            "winRate": round(wr, 2),
            "grossProfit": round(gross_profit, 4),
            "grossLoss": round(gross_loss, 4),
            "netPnl": round(net, 4),
            "pf": round(pf, 4),
        }

    result["systems"].append(
        {
            "apiKeyName": key,
            "apiKeyId": api_id,
            "totalEventsLoaded": len(prepared),
            "windows": windows_data,
        }
    )

print(json.dumps(result, ensure_ascii=False, indent=2))
con.close()

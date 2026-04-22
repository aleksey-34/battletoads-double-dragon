#!/usr/bin/env python3
import json
import sqlite3
import time

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
API_KEYS = ["HDB_15", "HDB_18", "ivan_weex_1"]

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

# Resolve api key ids
api_rows = cur.execute(
    "SELECT id,name FROM api_keys WHERE name IN (%s)" % ",".join("?" for _ in API_KEYS),
    API_KEYS,
).fetchall()
api = {r["name"]: int(r["id"]) for r in api_rows}

# live_trade_events schema
lte_cols = [r[1] for r in cur.execute("PRAGMA table_info(live_trade_events)").fetchall()]
if "strategy_id" not in lte_cols:
    raise RuntimeError("live_trade_events.strategy_id is required")
if "created_at" not in lte_cols:
    raise RuntimeError("live_trade_events.created_at is required")

now_ms = int(time.time() * 1000)
windows = {
    "1d": now_ms - 24 * 60 * 60 * 1000,
    "7d": now_ms - 7 * 24 * 60 * 60 * 1000,
    "30d": now_ms - 30 * 24 * 60 * 60 * 1000,
}


def calc_event_pnl(row):
    ttype = str(row.get("trade_type") or "").lower()
    if ttype not in ("exit", "close"):
        return 0.0

    try:
        entry_price = float(row.get("entry_price") or 0)
        exit_price = float(row.get("actual_price") or 0)
        qty = float(row.get("position_size") or 0)
        fee = float(row.get("actual_fee") or 0)
        side = str(row.get("side") or "long").lower()
    except Exception:
        return 0.0

    if entry_price <= 0 or exit_price <= 0 or qty <= 0:
        return 0.0

    direction = 1.0 if side in ("long", "buy") else -1.0
    pnl = (exit_price - entry_price) * qty * direction - fee
    return float(pnl)


result = {
    "generatedAtMs": now_ms,
    "windows": {k: {"fromMs": v} for k, v in windows.items()},
    "systems": [],
}

for key in API_KEYS:
    api_id = api.get(key)
    if not api_id:
        result["systems"].append({"apiKeyName": key, "error": "api_key_not_found"})
        continue

    # Current active strategy ids for this api key
    strategy_ids = [
        int(r["id"])
        for r in cur.execute(
            """
            SELECT id
            FROM strategies
            WHERE api_key_id = ?
              AND COALESCE(is_runtime, 1) = 1
              AND COALESCE(is_archived, 0) = 0
            """,
            (api_id,),
        ).fetchall()
    ]

    if not strategy_ids:
        result["systems"].append({"apiKeyName": key, "apiKeyId": api_id, "error": "no_strategies"})
        continue

    placeholders = ",".join("?" for _ in strategy_ids)
    rows = [
        dict(r)
        for r in cur.execute(
            f"""
            SELECT strategy_id, trade_type, side, entry_price, actual_price, position_size, actual_fee, created_at, source_symbol
            FROM live_trade_events
            WHERE strategy_id IN ({placeholders})
              AND created_at >= ?
            ORDER BY created_at DESC
            """,
            (*strategy_ids, windows["30d"]),
        ).fetchall()
    ]

    out_windows = {}
    for wname, start_ms in windows.items():
        subset = [r for r in rows if int(r.get("created_at") or 0) >= start_ms]
        exits = [r for r in subset if str(r.get("trade_type") or "").lower() in ("exit", "close")]
        pnls = [calc_event_pnl(r) for r in exits]
        wins = sum(1 for x in pnls if x > 0)
        losses = sum(1 for x in pnls if x < 0)
        total = len(pnls)
        gross_profit = sum(x for x in pnls if x > 0)
        gross_loss = abs(sum(x for x in pnls if x < 0))
        net = sum(pnls)
        pf = (gross_profit / gross_loss) if gross_loss > 1e-9 else (999.0 if gross_profit > 0 else 0.0)
        wr = (wins / total * 100.0) if total > 0 else 0.0
        out_windows[wname] = {
            "exitEvents": total,
            "wins": wins,
            "losses": losses,
            "winRate": round(wr, 2),
            "netPnl": round(net, 4),
            "grossProfit": round(gross_profit, 4),
            "grossLoss": round(gross_loss, 4),
            "pf": round(pf, 4),
        }

    result["systems"].append(
        {
            "apiKeyName": key,
            "apiKeyId": api_id,
            "strategyCount": len(strategy_ids),
            "events30d": len(rows),
            "windows": out_windows,
        }
    )

print(json.dumps(result, ensure_ascii=False, indent=2))
con.close()

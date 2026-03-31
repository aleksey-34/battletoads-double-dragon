#!/usr/bin/env python3
import argparse
import json
import sqlite3
from datetime import datetime, timezone
from urllib import request, parse

DB = "/opt/battletoads-double-dragon/backend/database.db"
API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "SuperSecure2026Admin!"


def fetch_all(conn, sql, params=()):
    cur = conn.execute(sql, params)
    cols = [d[0] for d in cur.description]
    return [{cols[i]: row[i] for i in range(len(cols))} for row in cur.fetchall()]


def fetch_one(conn, sql, params=()):
    rows = fetch_all(conn, sql, params)
    return rows[0] if rows else None


def api_get(path):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=120) as resp:
        return json.loads(resp.read().decode("utf-8"))


def to_iso(ts_ms):
    if not ts_ms:
        return None
    return datetime.fromtimestamp(int(ts_ms) / 1000, tz=timezone.utc).isoformat()


def normalize_candles(payload):
    rows = payload if isinstance(payload, list) else []
    out = []
    for item in rows:
        if isinstance(item, list) and len(item) >= 5:
            out.append({
                "ts": int(item[0]),
                "open": float(item[1]),
                "high": float(item[2]),
                "low": float(item[3]),
                "close": float(item[4]),
            })
    return out


def main():
    parser = argparse.ArgumentParser(description="Inspect runtime/master systems with latest bars and entry params")
    parser.add_argument("--system-name", action="append", required=True, dest="system_names")
    parser.add_argument("--bars", type=int, default=3)
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    out = {
        "generated_at_utc": datetime.now(timezone.utc).isoformat(),
        "systems": [],
    }

    strategy_cols = {row["name"] for row in fetch_all(conn, "PRAGMA table_info(strategies)")}
    param_candidates = [
        "interval",
        "length",
        "take_profit_percent",
        "stop_loss_percent",
        "zscore_entry",
        "zscore_exit",
        "zscore_stop",
        "entry_threshold",
        "exit_threshold",
        "detection_source",
    ]
    existing_param_cols = [col for col in param_candidates if col in strategy_cols]

    for system_name in args.system_names:
        system = fetch_one(
            conn,
            """
            SELECT ts.id AS system_id, ts.name, ts.is_active, ak.name AS api_key_name
            FROM trading_systems ts
            JOIN api_keys ak ON ak.id = ts.api_key_id
            WHERE ts.name = ?
            LIMIT 1
            """,
            (system_name,),
        )
        if not system:
            out["systems"].append({"systemName": system_name, "error": "system not found"})
            continue

        members = fetch_all(
            conn,
            """
            SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.is_active, s.last_signal, s.last_action, s.updated_at,
                   tsm.weight, COALESCE(tsm.is_enabled, 1) AS member_enabled
            FROM trading_system_members tsm
            JOIN strategies s ON s.id = tsm.strategy_id
            WHERE tsm.system_id = ?
            ORDER BY tsm.id
            """,
            (int(system["system_id"]),),
        )

        strategy_rows = []
        for member in members:
            strategy_id = int(member["id"])
            symbol = str(member.get("base_symbol") or "")
            if member.get("quote_symbol"):
                symbol = f"{member.get('base_symbol')}/{member.get('quote_symbol')}"

            full_row = fetch_one(
                conn,
                f"SELECT {', '.join(['id'] + existing_param_cols)} FROM strategies WHERE id = ?",
                (strategy_id,),
            ) or {}

            last_events = fetch_one(
                conn,
                """
                SELECT
                  MAX(actual_time) AS last_trade_event_ms,
                  SUM(CASE WHEN lower(COALESCE(trade_type,'')) = 'entry' AND actual_time >= (strftime('%s','now') - 86400) * 1000 THEN 1 ELSE 0 END) AS entries_1d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,'')) = 'exit' AND actual_time >= (strftime('%s','now') - 86400) * 1000 THEN 1 ELSE 0 END) AS exits_1d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,'')) = 'entry' AND actual_time >= (strftime('%s','now') - 604800) * 1000 THEN 1 ELSE 0 END) AS entries_7d,
                  SUM(CASE WHEN lower(COALESCE(trade_type,'')) = 'exit' AND actual_time >= (strftime('%s','now') - 604800) * 1000 THEN 1 ELSE 0 END) AS exits_7d
                FROM live_trade_events
                WHERE strategy_id = ?
                """,
                (strategy_id,),
            ) or {}

            candles = []
            candle_error = None
            if symbol:
                interval = str(full_row.get("interval") or "4h")
                try:
                    market_data = api_get(
                        f"/api/market-data/{parse.quote(str(system['api_key_name']), safe='')}?symbol={parse.quote(symbol, safe='')}&interval={parse.quote(interval, safe='')}&limit={max(2, int(args.bars))}"
                    )
                    candles = normalize_candles(market_data)[-max(2, int(args.bars)):]
                except Exception as exc:
                    candle_error = str(exc)

            strategy_rows.append({
                "strategyId": strategy_id,
                "strategyName": member.get("name"),
                "symbol": symbol,
                "memberEnabled": int(member.get("member_enabled") or 0) == 1,
                "weight": float(member.get("weight") or 0),
                "isActive": int(member.get("is_active") or 0) == 1,
                "lastSignal": member.get("last_signal"),
                "lastAction": member.get("last_action"),
                "strategyUpdatedAt": member.get("updated_at"),
                "lastTradeEventAt": to_iso(last_events.get("last_trade_event_ms")),
                "events": {
                    "entries1d": int(last_events.get("entries_1d") or 0),
                    "exits1d": int(last_events.get("exits_1d") or 0),
                    "entries7d": int(last_events.get("entries_7d") or 0),
                    "exits7d": int(last_events.get("exits_7d") or 0),
                },
                "entryConditions": {col: full_row.get(col) for col in existing_param_cols if full_row.get(col) is not None},
                "recentCandles": [{**candle, "tsUtc": to_iso(candle.get("ts"))} for candle in candles],
                "candlesError": candle_error,
            })

        out["systems"].append({
            "system": {
                "id": int(system["system_id"]),
                "name": str(system["name"]),
                "apiKey": str(system["api_key_name"]),
                "isActive": int(system.get("is_active") or 0) == 1,
            },
            "membersTotal": len(strategy_rows),
            "membersActive": sum(1 for row in strategy_rows if row.get("isActive")),
            "membersWithEvents1d": sum(1 for row in strategy_rows if (row["events"]["entries1d"] + row["events"]["exits1d"]) > 0),
            "membersWithEvents7d": sum(1 for row in strategy_rows if (row["events"]["entries7d"] + row["events"]["exits7d"]) > 0),
            "strategies": strategy_rows,
        })

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
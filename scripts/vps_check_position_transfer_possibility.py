#!/usr/bin/env python3
import json
import sqlite3
from urllib import request

DB = "/opt/battletoads-double-dragon/backend/database.db"
API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "SuperSecure2026Admin!"
TARGET_SYSTEM_NAME = "ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh"
API_KEY_HINTS = ["BTDD", "BTDD1", "MEHMET", "MUSTAFA"]


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
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
        },
        method="GET",
    )
    with request.urlopen(req, timeout=90) as resp:
        return json.loads(resp.read().decode("utf-8"))


def normalize_symbol(symbol):
    s = str(symbol or "").upper().replace("/", "").replace("-", "")
    for suffix in ["USDT", "USD", "PERP"]:
        s = s.replace(suffix, "")
    return s


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    target = fetch_one(
        conn,
        """
        SELECT ts.id AS system_id, ak.name AS api_key_name
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        WHERE ts.name = ?
        LIMIT 1
        """,
        (TARGET_SYSTEM_NAME,),
    )

    if not target:
        print(json.dumps({"error": "target system not found", "targetSystem": TARGET_SYSTEM_NAME}, ensure_ascii=False, indent=2))
        return

    target_members = fetch_all(
        conn,
        """
        SELECT s.id AS strategy_id, s.base_symbol, s.quote_symbol
        FROM trading_system_members tsm
        JOIN strategies s ON s.id = tsm.strategy_id
        WHERE tsm.system_id = ? AND COALESCE(tsm.is_enabled, 1) = 1
        """,
        (target["system_id"],),
    )
    target_pairs = sorted({f"{m.get('base_symbol')}/{m.get('quote_symbol')}" for m in target_members if m.get("base_symbol")})
    target_norm = {normalize_symbol(m.get("base_symbol")) for m in target_members if m.get("base_symbol")}

    candidates = []
    for hint in API_KEY_HINTS:
        rows = fetch_all(
            conn,
            "SELECT name FROM api_keys WHERE upper(name) LIKE ? ORDER BY name",
            (f"%{hint.upper()}%",),
        )
        for row in rows:
            name = str(row.get("name") or "").strip()
            if name and name not in candidates:
                candidates.append(name)

    report = {
        "targetSystem": {
            "name": TARGET_SYSTEM_NAME,
            "apiKey": target.get("api_key_name"),
            "membersEnabled": len(target_members),
            "pairs": target_pairs,
        },
        "checkedApiKeys": candidates,
        "accounts": [],
        "conclusion": {
            "positionTransferSupported": False,
            "notes": [
                "В коде нет механизма переноса позиции между системами/стратегиями как state migration.",
                "При stop-заявке используется closeAllPositions(apiKey), то есть позиции могут закрываться целиком.",
                "Снятие карточки с витрины закрывает позиции только если передан closePositions=true.",
            ],
        },
    }

    for api_key in candidates:
        try:
            data = api_get(f"/api/positions/{api_key}")
            positions = data if isinstance(data, list) else data.get("positions", []) if isinstance(data, dict) else []
        except Exception as exc:
            report["accounts"].append({"apiKey": api_key, "error": str(exc)})
            continue

        open_positions = []
        overlap = 0
        for p in positions or []:
            size = float(p.get("size") or 0)
            if abs(size) <= 0:
                continue
            symbol = str(p.get("symbol") or "")
            norm = normalize_symbol(symbol)
            is_overlap = norm in target_norm
            if is_overlap:
                overlap += 1
            open_positions.append({
                "symbol": symbol,
                "side": p.get("side"),
                "size": size,
                "entryPrice": p.get("entryPrice") or p.get("entry_price"),
                "pairInTargetSystem": is_overlap,
            })

        report["accounts"].append({
            "apiKey": api_key,
            "openPositionsCount": len(open_positions),
            "overlapWithTargetPairs": overlap,
            "positions": open_positions,
        })

    print(json.dumps(report, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

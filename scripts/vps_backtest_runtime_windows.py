#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib import request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "SuperSecure2026Admin!"
WINDOW_DAYS = [1, 7, 30]
INITIAL_BALANCE = 10000
DB = "/opt/battletoads-double-dragon/backend/database.db"

RUNTIME_SYSTEMS = [
    {"label": "Ruslan", "systemName": "ALGOFUND::ruslan"},
    {"label": "Ali", "systemName": "ALGOFUND::ali"},
]


def api_post(path, payload):
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        f"{API_BASE}{path}",
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ADMIN_TOKEN}",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve_runtime_system(conn, system_name):
    row = conn.execute(
        """
        SELECT ts.id AS system_id, ak.name AS api_key_name
        FROM trading_systems ts
        JOIN api_keys ak ON ak.id = ts.api_key_id
        WHERE ts.name = ?
        LIMIT 1
        """,
        (system_name,),
    ).fetchone()
    if not row:
        return None
    return {
        "systemId": int(row["system_id"]),
        "apiKeyName": str(row["api_key_name"]),
    }


def main():
    now = datetime.now(timezone.utc)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    output = {
        "generated_at_utc": now.isoformat(),
        "windows_days": WINDOW_DAYS,
        "systems": [],
    }

    for item in RUNTIME_SYSTEMS:
        system_name = item["systemName"]
        resolved = resolve_runtime_system(conn, system_name)
        system_report = {
            "label": item["label"],
            "systemName": system_name,
            "runtimeSystem": resolved,
            "windows": [],
        }
        if not resolved:
            system_report["error"] = "runtime system not found"
            output["systems"].append(system_report)
            continue
        for days in WINDOW_DAYS:
            date_to = now
            date_from = now - timedelta(days=days)
            payload = {
                "dateFrom": date_from.isoformat(),
                "dateTo": date_to.isoformat(),
                "bars": 8000,
                "warmupBars": 400,
                "initialBalance": INITIAL_BALANCE,
                "riskMultiplier": 1.0,
                "saveResult": False,
            }
            try:
                data = api_post(
                    f"/api/trading-systems/{resolved['apiKeyName']}/{resolved['systemId']}/backtest",
                    payload,
                )
                summary = (data or {}).get("result", {}).get("summary", {}) or {}
                final_equity = float(summary.get("finalEquity") or INITIAL_BALANCE)
                system_report["windows"].append({
                    "days": days,
                    "dateFrom": date_from.isoformat(),
                    "dateTo": date_to.isoformat(),
                    "trades": int(summary.get("tradesCount") or 0),
                    "returnPercent": float(summary.get("totalReturnPercent") or 0),
                    "profitLoss": final_equity - INITIAL_BALANCE,
                    "profitFactor": float(summary.get("profitFactor") or 0),
                    "maxDrawdownPercent": float(summary.get("maxDrawdownPercent") or 0),
                })
            except Exception as exc:
                system_report["windows"].append({
                    "days": days,
                    "dateFrom": date_from.isoformat(),
                    "dateTo": date_to.isoformat(),
                    "error": str(exc),
                })

        output["systems"].append(system_report)

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

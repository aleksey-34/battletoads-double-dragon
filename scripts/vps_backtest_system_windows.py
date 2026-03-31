#!/usr/bin/env python3
import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib import request, parse

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "SuperSecure2026Admin!"
DEFAULT_WINDOWS = [1, 7, 30]
DEFAULT_INITIAL_BALANCE = 10000
DB = "/opt/battletoads-double-dragon/backend/database.db"


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
    with request.urlopen(req, timeout=240) as resp:
        return json.loads(resp.read().decode("utf-8"))


def resolve_system(conn, system_name):
    row = conn.execute(
        """
        SELECT ts.id AS system_id, ts.name, ak.name AS api_key_name, ts.is_active
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
        "systemName": str(row["name"]),
        "apiKeyName": str(row["api_key_name"]),
        "isActive": int(row["is_active"] or 0) == 1,
    }


def main():
    parser = argparse.ArgumentParser(description="Run 1d/7d/30d backtests for trading systems by system name")
    parser.add_argument("--system-name", action="append", required=True, dest="system_names")
    parser.add_argument("--windows", default=",".join(str(item) for item in DEFAULT_WINDOWS))
    parser.add_argument("--initial-balance", type=float, default=DEFAULT_INITIAL_BALANCE)
    parser.add_argument("--bars", type=int, default=8000)
    parser.add_argument("--warmup-bars", type=int, default=400)
    args = parser.parse_args()

    windows = []
    for token in str(args.windows or "").split(","):
      token = token.strip()
      if not token:
        continue
      windows.append(max(1, int(token)))
    windows = windows or list(DEFAULT_WINDOWS)

    now = datetime.now(timezone.utc)
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    output = {
        "generated_at_utc": now.isoformat(),
        "windows_days": windows,
        "systems": [],
    }

    for system_name in args.system_names:
        system_label = str(system_name or "").strip()
        resolved = resolve_system(conn, system_label)
        system_report = {
            "systemName": system_label,
            "runtimeSystem": resolved,
            "windows": [],
        }
        if not resolved:
            system_report["error"] = "system not found"
            output["systems"].append(system_report)
            continue

        for days in windows:
            date_to = now
            date_from = now - timedelta(days=days)
            payload = {
                "dateFrom": date_from.isoformat(),
                "dateTo": date_to.isoformat(),
                "bars": int(args.bars),
                "warmupBars": int(args.warmup_bars),
                "initialBalance": float(args.initial_balance),
                "riskMultiplier": 1.0,
                "saveResult": False,
            }
            try:
                data = api_post(
                    f"/api/trading-systems/{parse.quote(resolved['apiKeyName'], safe='')}/{resolved['systemId']}/backtest",
                    payload,
                )
                summary = (data or {}).get("result", {}).get("summary", {}) or {}
                final_equity = float(summary.get("finalEquity") or args.initial_balance)
                system_report["windows"].append({
                    "days": days,
                    "dateFrom": date_from.isoformat(),
                    "dateTo": date_to.isoformat(),
                    "trades": int(summary.get("tradesCount") or 0),
                    "returnPercent": float(summary.get("totalReturnPercent") or 0),
                    "profitLoss": final_equity - float(args.initial_balance),
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
#!/usr/bin/env python3
import argparse
import json
import sqlite3
from datetime import datetime, timedelta, timezone
from urllib import parse, request, error

DB = "/opt/battletoads-double-dragon/backend/database.db"
BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "SuperSecure2026Admin!"
DEFAULT_WINDOWS = [1, 7, 30]


def api_get(path):
    req = request.Request(
        f"{BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=180) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post(path, payload):
    req = request.Request(
        f"{BASE}{path}",
        data=json.dumps(payload).encode("utf-8"),
        headers={
            "Authorization": f"Bearer {ADMIN_TOKEN}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def api_post_safe(path, payload):
    try:
        return {"ok": True, "data": api_post(path, payload)}
    except error.HTTPError as exc:
        body = ""
        try:
            body = exc.read().decode("utf-8", errors="ignore")
        except Exception:
            body = ""
        return {
            "ok": False,
            "error": f"HTTP {exc.code}",
            "body": body[:2000],
        }
    except Exception as exc:
        return {
            "ok": False,
            "error": str(exc),
            "body": "",
        }


def parse_windows(raw):
    values = []
    for item in str(raw or "").split(","):
        token = item.strip()
        if not token:
            continue
        values.append(max(1, int(token)))
    return values or list(DEFAULT_WINDOWS)


def find_system(conn, system_name):
    row = conn.execute(
        """
        SELECT ts.id AS system_id, ts.name, ts.is_active, ak.name AS api_key_name
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


def find_snapshot_settings(offer_store, system_name):
    snapshots = ((offer_store or {}).get("tsBacktestSnapshots") or {})
    by_exact = snapshots.get(system_name)
    if isinstance(by_exact, dict):
        settings = by_exact.get("backtestSettings") or {}
        return {
            "snapshotKey": system_name,
            "settings": settings,
            "summary": by_exact,
        }

    token = system_name.split("::")[-1].strip().lower()
    for key, value in snapshots.items():
        if token and token in str(key or "").lower():
            settings = (value or {}).get("backtestSettings") or {}
            return {
                "snapshotKey": str(key),
                "settings": settings,
                "summary": value,
            }
    return {
        "snapshotKey": None,
        "settings": {},
        "summary": None,
    }


def main():
    parser = argparse.ArgumentParser(description="Run windows on currently saved active card using stored settings")
    parser.add_argument("--system-name", default="ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh")
    parser.add_argument("--windows", default="1,7,30")
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    system = find_system(conn, str(args.system_name).strip())
    windows = parse_windows(args.windows)
    now = datetime.now(timezone.utc)

    result = {
        "generatedAtUtc": now.isoformat(),
        "targetSystem": system,
        "windows": windows,
        "settings": {},
        "runs": [],
    }

    if not system:
        result["error"] = "system_not_found"
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return

    offer_store = api_get("/api/saas/admin/offer-store")
    snap_info = find_snapshot_settings(offer_store, system["systemName"])
    settings = snap_info.get("settings") or {}

    initial_balance = float(settings.get("initialBalance") or 10000)
    risk_score = float(settings.get("riskScore") or 5)
    trade_score = float(settings.get("tradeFrequencyScore") or 5)
    risk_cap = float(settings.get("riskScaleMaxPercent") or 40)

    result["settings"] = {
        "snapshotKey": snap_info.get("snapshotKey"),
        "initialBalance": initial_balance,
        "riskScore": risk_score,
        "tradeFrequencyScore": trade_score,
        "riskScaleMaxPercent": risk_cap,
    }

    for days in windows:
        date_to = now
        date_from = now - timedelta(days=int(days))

        preview_payload = {
            "source": "runtime_system",
            "kind": "algofund-ts",
            "systemName": system["systemName"],
            "preferRealBacktest": True,
            "dateFrom": date_from.isoformat(),
            "dateTo": date_to.isoformat(),
            "initialBalance": initial_balance,
            "riskScore": risk_score,
            "tradeFrequencyScore": trade_score,
            "riskScaleMaxPercent": risk_cap,
        }

        direct_payload = {
            "dateFrom": date_from.isoformat(),
            "dateTo": date_to.isoformat(),
            "bars": 8000,
            "warmupBars": 400,
            "initialBalance": initial_balance,
            "riskMultiplier": 1.0,
            "saveResult": False,
        }

        preview = api_post_safe("/api/saas/admin/sweep-backtest-preview", preview_payload)
        direct = api_post_safe(
            f"/api/trading-systems/{parse.quote(system['apiKeyName'], safe='')}/{system['systemId']}/backtest",
            direct_payload,
        )

        run = {
            "days": int(days),
            "dateFrom": date_from.isoformat(),
            "dateTo": date_to.isoformat(),
            "preview": {},
            "direct": {},
        }

        if preview.get("ok"):
            data = preview.get("data") or {}
            summary = (data.get("preview") or {}).get("summary") or {}
            run["preview"] = {
                "ok": True,
                "source": (data.get("preview") or {}).get("source"),
                "selectedOffers": len(data.get("selectedOffers") or []),
                "trades": int(summary.get("tradesCount") or 0),
                "returnPercent": float(summary.get("totalReturnPercent") or 0),
                "profitFactor": float(summary.get("profitFactor") or 0),
                "maxDrawdownPercent": float(summary.get("maxDrawdownPercent") or 0),
                "finalEquity": float(summary.get("finalEquity") or initial_balance),
            }
        else:
            run["preview"] = {
                "ok": False,
                "error": preview.get("error"),
                "body": preview.get("body"),
            }

        if direct.get("ok"):
            data = direct.get("data") or {}
            summary = ((data.get("result") or {}).get("summary") or {})
            run["direct"] = {
                "ok": True,
                "trades": int(summary.get("tradesCount") or 0),
                "returnPercent": float(summary.get("totalReturnPercent") or 0),
                "profitFactor": float(summary.get("profitFactor") or 0),
                "maxDrawdownPercent": float(summary.get("maxDrawdownPercent") or 0),
                "finalEquity": float(summary.get("finalEquity") or initial_balance),
            }
        else:
            run["direct"] = {
                "ok": False,
                "error": direct.get("error"),
                "body": direct.get("body"),
            }

        result["runs"].append(run)

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
import argparse
import json
from datetime import datetime, timedelta, timezone
from urllib import request

API_BASE = "http://127.0.0.1:3001/api/saas/admin/sweep-backtest-preview"
ADMIN_TOKEN = "SuperSecure2026Admin!"
DEFAULT_WINDOWS = [1, 7, 30]
DEFAULT_INITIAL_BALANCE = 10000


def api_post(payload):
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        API_BASE,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ADMIN_TOKEN}",
        },
        method="POST",
    )
    with request.urlopen(req, timeout=300) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    parser = argparse.ArgumentParser(description="Run admin preview backtests for system windows")
    parser.add_argument("--system-name", action="append", required=True, dest="system_names")
    parser.add_argument("--windows", default=",".join(str(item) for item in DEFAULT_WINDOWS))
    parser.add_argument("--initial-balance", type=float, default=DEFAULT_INITIAL_BALANCE)
    parser.add_argument("--risk-score", type=float, default=5)
    parser.add_argument("--trade-score", type=float, default=5)
    parser.add_argument("--risk-scale-max-percent", type=float, default=40)
    parser.add_argument("--prefer-real-backtest", action="store_true")
    args = parser.parse_args()

    windows = []
    for token in str(args.windows or "").split(","):
        token = token.strip()
        if not token:
            continue
        windows.append(max(1, int(token)))
    windows = windows or list(DEFAULT_WINDOWS)

    now = datetime.now(timezone.utc)
    output = {
        "generated_at_utc": now.isoformat(),
        "windows_days": windows,
        "systems": [],
    }

    for system_name in args.system_names:
        report = {
            "systemName": str(system_name or "").strip(),
            "windows": [],
        }
        for days in windows:
            date_to = now
            date_from = now - timedelta(days=days)
            payload = {
                "source": "runtime_system",
                "kind": "algofund-ts",
                "systemName": report["systemName"],
                "preferRealBacktest": bool(args.prefer_real_backtest),
                "dateFrom": date_from.isoformat(),
                "dateTo": date_to.isoformat(),
                "initialBalance": float(args.initial_balance),
                "riskScore": float(args.risk_score),
                "tradeFrequencyScore": float(args.trade_score),
                "riskScaleMaxPercent": float(args.risk_scale_max_percent),
            }
            try:
                data = api_post(payload)
                summary = (data.get("preview") or {}).get("summary") or {}
                final_equity = float(summary.get("finalEquity") or args.initial_balance)
                report["windows"].append({
                    "days": days,
                    "dateFrom": date_from.isoformat(),
                    "dateTo": date_to.isoformat(),
                    "selectedOffers": len(data.get("selectedOffers") or []),
                    "trades": int(summary.get("tradesCount") or 0),
                    "returnPercent": float(summary.get("totalReturnPercent") or 0),
                    "profitLoss": final_equity - float(args.initial_balance),
                    "profitFactor": float(summary.get("profitFactor") or 0),
                    "maxDrawdownPercent": float(summary.get("maxDrawdownPercent") or 0),
                    "source": (data.get("preview") or {}).get("source"),
                })
            except Exception as exc:
                report["windows"].append({
                    "days": days,
                    "dateFrom": date_from.isoformat(),
                    "dateTo": date_to.isoformat(),
                    "error": str(exc),
                })
        output["systems"].append(report)

    print(json.dumps(output, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
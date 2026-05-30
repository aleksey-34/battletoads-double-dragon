#!/usr/bin/env python3
"""Verify TS-only metrics match between admin sweep rerun and TS+DCA combined preview."""
from __future__ import annotations

import json
import os
import sys
import time

import requests

from datetime import datetime, timedelta, timezone

API = os.environ.get("BTDD_API", "http://localhost:3001")
AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "Bearer btdd_admin_sweep_2026")
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

SET_KEY = os.environ.get("PARITY_SET_KEY", "balanced-portfolio-v2")
OFFER_LIMIT = int(os.environ.get("PARITY_OFFER_LIMIT", "5"))
RISK = float(os.environ.get("PARITY_RISK", "2.2"))
REINVEST = float(os.environ.get("PARITY_REINVEST", "0"))
RISK_MAX = float(os.environ.get("PARITY_RISK_MAX", "50"))


def post(path: str, payload: dict, timeout: int = 300) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"{path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def get(path: str) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=60)
    if r.status_code >= 400:
        raise RuntimeError(f"{path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def poll_combined() -> dict:
    for _ in range(600):
        st = get("/api/saas/admin/ts-dca-combined-preview-status")
        if not st.get("running"):
            if st.get("error"):
                raise RuntimeError(st["error"])
            if st.get("result"):
                return st["result"]
            raise RuntimeError("combined preview empty")
        time.sleep(2)
    raise RuntimeError("combined timeout")


def main() -> int:
    store = get("/api/saas/admin/offer-store")
    snap = (store.get("tsBacktestSnapshots") or {}).get(SET_KEY)
    if not snap:
        print(f"Missing snapshot: {SET_KEY}", file=sys.stderr)
        return 1

    offer_ids = (snap.get("offerIds") or [])[:OFFER_LIMIT]
    bs = snap.get("backtestSettings") or {}
    balance = float(bs.get("initialBalance") or 10000)
    api_key = snap.get("apiKeyName") or None
    system_name = snap.get("systemName") or None

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=int(os.environ.get("PARITY_DAYS", "90")))
    date_from = start.isoformat()
    date_to = end.isoformat()

    print(f"=== Parity check: {SET_KEY} risk={RISK} reinvest={REINVEST}% period={date_from}..{date_to} offers={len(offer_ids)} ===")

    sweep = post("/api/saas/admin/sweep-backtest-preview", {
        "kind": "algofund-ts",
        "setKey": SET_KEY,
        "offerIds": offer_ids,
        "apiKeyName": api_key,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": balance,
        "riskScore": RISK,
        "tradeFrequencyScore": float(bs.get("tradeFrequencyScore") or 5),
        "reinvestPercent": REINVEST,
        "riskScaleMaxPercent": RISK_MAX,
        "preferRealBacktest": True,
    }, timeout=600)

    rerun = sweep.get("rerun") or {}
    preview_summary = (sweep.get("preview") or {}).get("summary") or {}
    if not rerun.get("executed") and not preview_summary:
        print("Rerun failed:", rerun.get("error"), file=sys.stderr)
        return 1

    rerun_dd = float(rerun.get("maxDrawdownPercent") or preview_summary.get("maxDrawdownPercent") or 0)
    rerun_ret = float(rerun.get("totalReturnPercent") or preview_summary.get("totalReturnPercent") or 0)
    print(f"Admin rerun TS-only: ret={rerun_ret:.3f}% dd={rerun_dd:.3f}%")

    # Use last DCA scan top-2 if available
    scan_st = get("/api/saas/admin/ts-dca-research-status")
    scan = scan_st.get("result") or {}
    markets = [
        str(c["market"]) for c in (scan.get("candidates") or [])
        if c.get("status") == "ok" and int(c.get("trades") or 0) > 0
    ][:2]
    if not markets:
        markets = ["XRPUSDT", "LTCUSDT"]
    print(f"DCA markets for combined: {markets}")

    dca_body = {
        "systemName": system_name,
        "setKey": SET_KEY,
        "apiKeyName": api_key,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": balance,
        "riskScore": RISK,
        "tradeFrequencyScore": float(bs.get("tradeFrequencyScore") or 5),
        "reinvestPercent": REINVEST,
        "riskScaleMaxPercent": RISK_MAX,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": 1,
        "dcaInterval": "1h",
        "dcaStepPercent": 0.8,
        "dcaMaxOrders": 12,
        "dcaTpPercent": 1.2,
        "markets": markets,
        "enabled": True,
    }
    post("/api/saas/admin/ts-dca-combined-preview", dca_body, timeout=60)
    combined = poll_combined()

    ts_only = (combined.get("tsOnly") or {}).get("summary") or {}
    comb = (combined.get("combined") or {}).get("summary") or {}
    ts_dd = float(ts_only.get("maxDrawdownPercent") or 0)
    ts_ret = float(ts_only.get("totalReturnPercent") or 0)
    comb_dd = float(comb.get("maxDrawdownPercent") or 0)
    comb_ret = float(comb.get("totalReturnPercent") or 0)

    print(f"Combined engine TS-only: ret={ts_ret:.3f}% dd={ts_dd:.3f}%")
    print(f"Combined portfolio:      ret={comb_ret:.3f}% dd={comb_dd:.3f}%")
    print(f"Delta TS-only vs rerun:  ret={ts_ret - rerun_ret:+.3f}% dd={ts_dd - rerun_dd:+.3f}%")

    ok = abs(ts_dd - rerun_dd) <= max(2.0, rerun_dd * 0.15)
    print("PASS" if ok else "FAIL", f"(TS-only DD gap {abs(ts_dd - rerun_dd):.2f}%)")
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())

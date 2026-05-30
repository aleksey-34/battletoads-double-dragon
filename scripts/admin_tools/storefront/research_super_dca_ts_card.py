#!/usr/bin/env python3
"""
Research + draft SUPER aggressive DCA TS card (90d window).

Trend offers = protective TS core (few high-PF trend strategies from mega-portfolio).
DCA layer = SUPER preset scan (2% base, 1h, step 0.6, 15 orders, TP 1%).

Usage on VPS after API is up:
  python3 scripts/admin_tools/storefront/research_super_dca_ts_card.py
  python3 scripts/admin_tools/storefront/research_super_dca_ts_card.py --apply

Requires ADMIN_SWEEP_TOKEN in env or default bearer from resync_ts_snapshots.
"""
from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timedelta, timezone

import requests

API = os.environ.get("BTDD_API", "http://localhost:3001")
AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "Bearer btdd_admin_sweep_2026")
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

SET_KEY = "mega-dca-super"
DISPLAY_LABEL = "Mega DCA SUPER (90d)"
BASE_SET_KEYS = ("mega-portfolio", "balanced-portfolio-v2", "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2")
TREND_OFFER_COUNT = 5
DCA_MARKETS = 2
PERIOD_DAYS = 90


def api_post(path: str, payload: dict, timeout: int = 120) -> dict:
    resp = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {resp.status_code}: {resp.text[:400]}")
    return resp.json()


def api_get(path: str, timeout: int = 60) -> dict:
    resp = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {resp.status_code}: {resp.text[:400]}")
    return resp.json()


def poll_dca_scan() -> dict:
    for i in range(600):
        status = api_get("/api/saas/admin/ts-dca-research-status")
        if status.get("running"):
            if i % 15 == 0:
                print(f"  scan… {status.get('progressPercent', 0)}% {status.get('currentMarket', '')}")
            time.sleep(2)
            continue
        if status.get("error"):
            raise RuntimeError(str(status["error"]))
        result = status.get("result")
        if result:
            return result
        raise RuntimeError("DCA scan finished without result")
    raise RuntimeError("DCA scan timeout")


def poll_combined_preview() -> dict:
    for i in range(600):
        status = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if status.get("running"):
            if i % 15 == 0:
                print("  combined preview running…")
            time.sleep(2)
            continue
        if status.get("error"):
            raise RuntimeError(str(status["error"]))
        result = status.get("result")
        if result:
            return result
        raise RuntimeError("Combined preview finished without result")
    raise RuntimeError("Combined preview timeout")


def pick_trend_offers(store: dict) -> tuple[list[str], dict]:
    snaps = store.get("tsBacktestSnapshots") or {}
    base = None
    base_key = ""
    for key in BASE_SET_KEYS:
        candidate = snaps.get(key)
        if candidate and len(candidate.get("offerIds") or []) >= 3:
            base = candidate
            base_key = key
            break
    if not base:
        raise RuntimeError(f"No base TS snapshot among {BASE_SET_KEYS}")
    offer_ids = list(base.get("offerIds") or [])

    review = store.get("offerReviewSnapshots") or {}
    scored: list[tuple[float, str]] = []
    for oid in offer_ids[:25]:
        snap = review.get(oid) or {}
        ret = float(snap.get("ret") or 0)
        dd = float(snap.get("dd") or 99)
        pf = float(snap.get("pf") or 0)
        trades = int(snap.get("trades") or 0)
        if trades < 5 or pf < 1.2:
            continue
        # Protective trend core: moderate DD, solid PF, not extreme lottery ret
        score = pf * 2 + min(ret, 80) * 0.05 - dd * 0.15
        scored.append((score, oid))
    scored.sort(reverse=True)
    picked = [oid for _, oid in scored[:TREND_OFFER_COUNT]]
    if len(picked) < 3:
        picked = offer_ids[:TREND_OFFER_COUNT]
    return picked, base


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Save draft TS snapshot to offer store")
    args = parser.parse_args()

    end = datetime.now(timezone.utc).date()
    start = end - timedelta(days=PERIOD_DAYS)
    date_from = start.isoformat()
    date_to = end.isoformat()

    print(f"Loading offer store from {API}...")
    store = api_get("/api/saas/admin/offer-store")
    trend_offers, base_ts = pick_trend_offers(store)
    base_set_key = str(base_ts.get("setKey") or "balanced-portfolio-v2")
    print(f"Base snapshot: {base_set_key}")
    print(f"Trend protection offers ({len(trend_offers)}): {', '.join(trend_offers[:5])}...")

    api_key = base_ts.get("apiKeyName") or ""
    initial_balance = float((base_ts.get("backtestSettings") or {}).get("initialBalance") or 10000)

    # Seed draft snapshot so DCA/combined resolve the same 5-offer TS core (not full 38-strat portfolio).
    if args.apply or True:
        seed_resp = requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
            "tsBacktestSnapshotsPatch": {
                SET_KEY: {
                    "setKey": SET_KEY,
                    "displayLabel": DISPLAY_LABEL,
                    "offerIds": trend_offers,
                    "apiKeyName": api_key,
                    "systemName": base_ts.get("systemName") or f"ALGOFUND_MASTER::BTDD_D1::{SET_KEY}",
                    "ret": 0,
                    "pf": 0,
                    "dd": 0,
                    "trades": 0,
                    "periodDays": PERIOD_DAYS,
                    "backtestSettings": {
                        "initialBalance": initial_balance,
                        "riskScore": 6,
                        "tradeFrequencyScore": 6,
                        "reinvestPercent": 0,
                        "riskScaleMaxPercent": 50,
                    },
                },
            },
        }, timeout=60)
        if seed_resp.status_code >= 400:
            raise RuntimeError(f"Seed snapshot failed: {seed_resp.status_code}")

    print(f"\n=== TS-only rerun 90d ({date_from} .. {date_to}) ===")
    ts_preview = api_post("/api/saas/admin/sweep-backtest-preview", {
        "kind": "algofund-ts",
        "setKey": SET_KEY,
        "offerIds": trend_offers,
        "apiKeyName": api_key or None,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": initial_balance,
        "riskScore": 6,
        "tradeFrequencyScore": 6,
        "reinvestPercent": 0,
        "riskScaleMaxPercent": 50,
        "preferRealBacktest": True,
    }, timeout=300)
    ts_summary = (ts_preview.get("preview") or {}).get("summary") or ts_preview.get("rerun") or {}
    print(f"  TS ret={ts_summary.get('totalReturnPercent')} dd={ts_summary.get('maxDrawdownPercent')} trades={ts_summary.get('tradesCount')}")

    dca_payload = {
        "systemName": base_ts.get("systemName") or f"ALGOFUND_MASTER::BTDD_D1::{SET_KEY}",
        "setKey": SET_KEY,
        "apiKeyName": api_key or None,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": initial_balance,
        "riskScore": 6,
        "tradeFrequencyScore": 6,
        "reinvestPercent": 0,
        "riskScaleMaxPercent": 50,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": 2,
        "dcaInterval": "1h",
        "dcaStepPercent": 0.6,
        "dcaMaxOrders": 15,
        "dcaTpPercent": 1,
        "dcaSlPercent": 0,
        "dcaEntryFilter": "always",
        "dcaReentryBars": 0,
        "dcaPerLegSl": False,
        "dcaAutotune": True,
        "maxCandidates": 20,
        "dcaForceRefresh": True,
    }

    print("\n=== SUPER DCA scan ===")
    api_post("/api/saas/admin/ts-dca-pair-research", dca_payload, timeout=60)
    scan = poll_dca_scan()
    candidates = [c for c in (scan.get("candidates") or []) if c.get("status") == "ok" and int(c.get("trades") or 0) > 0]
    candidates.sort(key=lambda c: float(c.get("score") or 0), reverse=True)
    markets = [str(c["market"]) for c in candidates[:DCA_MARKETS]]
    print(f"  viable={scan.get('viableCount')} picked={markets}")
    if not markets:
        raise RuntimeError("No viable DCA markets from SUPER scan")

    tuning = {}
    by_market = {str(c["market"]): c for c in candidates}
    for m in markets:
        row = by_market.get(m) or {}
        tuning[m] = {
            "interval": row.get("interval"),
            "stepPercent": row.get("stepPercent"),
            "tpPercent": row.get("tpPercent"),
            "slPercent": row.get("slPercent"),
            "entryFilter": row.get("entryFilter"),
            "perLegSl": row.get("perLegSl"),
        }

    print("\n=== TS+DCA combined preview ===")
    combined_payload = {
        **dca_payload,
        "markets": markets,
        "marketTuning": tuning,
        "enabled": True,
    }
    api_post("/api/saas/admin/ts-dca-combined-preview", combined_payload, timeout=60)
    combined = poll_combined_preview()
    c_sum = (combined.get("combined") or {}).get("summary") or {}
    t_sum = (combined.get("tsOnly") or {}).get("summary") or {}
    d_sum = (combined.get("dcaOnly") or {}).get("summary") or {}
    print(f"  TS only: ret={t_sum.get('totalReturnPercent')}% dd={t_sum.get('maxDrawdownPercent')}%")
    print(f"  DCA layer: ret={d_sum.get('totalReturnPercent')}% dd={d_sum.get('maxDrawdownPercent')}% trades={d_sum.get('tradesCount')}")
    print(f"  COMBINED: ret={c_sum.get('totalReturnPercent')}% dd={c_sum.get('maxDrawdownPercent')}% trades={c_sum.get('tradesCount')}")

    report = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "periodDays": PERIOD_DAYS,
        "dateFrom": date_from,
        "dateTo": date_to,
        "trendOfferIds": trend_offers,
        "dcaMarkets": markets,
        "dcaTuning": tuning,
        "tsOnly": t_sum,
        "dcaOnly": d_sum,
        "combined": c_sum,
        "delta": combined.get("delta"),
    }
    out_path = f"/tmp/{SET_KEY}_research_{date_to}.json"
    with open(out_path, "w") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved: {out_path}")

    if not args.apply:
        print("\nDry-run complete. Re-run with --apply to patch offer store snapshot.")
        return

    patch = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": trend_offers,
        "apiKeyName": api_key,
        "ret": float(c_sum.get("totalReturnPercent") or 0),
        "pf": float(c_sum.get("profitFactor") or 0),
        "dd": float(c_sum.get("maxDrawdownPercent") or 0),
        "trades": int(c_sum.get("tradesCount") or 0),
        "finalEquity": float(c_sum.get("finalEquity") or initial_balance),
        "periodDays": PERIOD_DAYS,
        "backtestSettings": {
            "initialBalance": initial_balance,
            "riskScore": 6,
            "tradeFrequencyScore": 6,
            "reinvestPercent": 0,
            "riskScaleMaxPercent": 50,
            "dateFrom": date_from,
            "dateTo": date_to,
        },
        "dcaMeta": {
            "enabled": True,
            "markets": markets,
            "tuning": tuning,
            "preset": "super",
        },
    }
    patch_resp = requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
        "tsBacktestSnapshotsPatch": {
            SET_KEY: {
                **patch,
                "winRate": 0,
                "tradesPerDay": round(patch["trades"] / max(1, PERIOD_DAYS), 3),
                "equityPoints": [],
            },
        },
    }, timeout=60)
    if patch_resp.status_code >= 400:
        raise RuntimeError(f"PATCH failed: {patch_resp.status_code} {patch_resp.text[:300]}")
    print(f"Snapshot patched via offer-store: {SET_KEY}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Research + publish SUPER aggressive DCA TS card (90d window).

Trend offers = protective TS core (few high-PF trend strategies from mega-portfolio).
DCA layer = SUPER preset scan (aggressive sizing by default).

Usage on VPS after API is up:
  python3 scripts/admin_tools/storefront/research_super_dca_ts_card.py
  python3 scripts/admin_tools/storefront/research_super_dca_ts_card.py --apply
  python3 scripts/admin_tools/storefront/research_super_dca_ts_card.py --apply --publish

Requires ADMIN_SWEEP_TOKEN in env or default bearer from resync_ts_snapshots.
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timedelta, timezone

import requests

API = os.environ.get("BTDD_API", "http://localhost:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

SET_KEY = "mega-dca-super"
DISPLAY_LABEL = "Mega DCA SUPER (90d)"
BASE_SET_KEYS = ("mega-portfolio", "balanced-portfolio-v2", "ALGOFUND_MASTER::BTDD_D1::balanced-portfolio-v2")
TREND_OFFER_COUNT = int(os.environ.get("SUPER_TREND_OFFERS", "5"))
PERIOD_DAYS = int(os.environ.get("SUPER_PERIOD_DAYS", "90"))
DATE_FROM_OVERRIDE = os.environ.get("SUPER_DATE_FROM", "2026-02-24").strip()
INITIAL_BALANCE = float(os.environ.get("SUPER_INITIAL_BALANCE", "10000"))
EXISTING_SYSTEM_NAME = os.environ.get(
    "SUPER_PUBLISH_SYSTEM",
    "ALGOFUND_MASTER::BTDD_D1::mega-dca-super-cwvuuw",
).strip()
PREFER_MARKETS = [
    m.strip().upper() for m in os.environ.get("SUPER_DCA_PREFER_MARKETS", "INJUSDT,NEARUSDT").split(",") if m.strip()
]

# Profit-oriented preset: low TS risk + aggressive DCA layer (Feb24 90d window)
RISK_SCORE = float(os.environ.get("SUPER_RISK_SCORE", "3"))
TRADE_FREQ = float(os.environ.get("SUPER_TRADE_FREQ", "6"))
REINVEST_PERCENT = float(os.environ.get("SUPER_REINVEST", "0"))
RISK_SCALE_MAX = float(os.environ.get("SUPER_RISK_SCALE_MAX", "70"))
DCA_MARKETS = int(os.environ.get("SUPER_DCA_MARKETS", "2"))
DCA_BASE_PERCENT = float(os.environ.get("SUPER_DCA_BASE_PERCENT", "10"))
DCA_INTERVAL = os.environ.get("SUPER_DCA_INTERVAL", "1h")
DCA_STEP = float(os.environ.get("SUPER_DCA_STEP", "0.5"))
DCA_MAX_ORDERS = int(os.environ.get("SUPER_DCA_MAX_ORDERS", "20"))
DCA_TP = float(os.environ.get("SUPER_DCA_TP", "1.2"))
MAX_CANDIDATES = int(os.environ.get("SUPER_DCA_MAX_CANDIDATES", "30"))


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


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    resp = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {resp.status_code}: {resp.text[:400]}")
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
    for key in BASE_SET_KEYS:
        candidate = snaps.get(key)
        if candidate and len(candidate.get("offerIds") or []) >= 3:
            base = candidate
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
        # Defensive TS core: prioritize PF and low DD over lottery ret
        score = pf * 2.5 - dd * 0.25 + min(max(ret, -5), 25) * 0.04
        scored.append((score, oid))
    scored.sort(reverse=True)
    picked = [oid for _, oid in scored[:TREND_OFFER_COUNT]]
    if len(picked) < 3:
        picked = offer_ids[:TREND_OFFER_COUNT]
    return picked, base


def pick_dca_markets(candidates: list[dict]) -> list[str]:
    viable = [
        c for c in candidates
        if c.get("status") == "ok" and int(c.get("trades") or 0) > 0
    ]
    by_market = {str(c.get("market") or "").upper(): c for c in viable}
    picked: list[str] = []
    for preferred in PREFER_MARKETS:
        if preferred in by_market and preferred not in picked:
            picked.append(preferred)
        if len(picked) >= DCA_MARKETS:
            return picked
    ranked = sorted(
        viable,
        key=lambda c: (
            float(c.get("ret") or 0),
            float(c.get("pf") or 0),
            -float(c.get("dd") or 99),
            float(c.get("score") or 0),
        ),
        reverse=True,
    )
    for row in ranked:
        market = str(row.get("market") or "").upper()
        if market and market not in picked:
            picked.append(market)
        if len(picked) >= DCA_MARKETS:
            break
    return picked


def extract_equity_points(equity_curve, limit: int = 160) -> list[float]:
    if not isinstance(equity_curve, list):
        return []
    points: list[float] = []
    for item in equity_curve:
        if isinstance(item, dict):
            val = item.get("equity", item.get("value"))
        else:
            val = item
        if val is None:
            continue
        try:
            points.append(float(val))
        except (TypeError, ValueError):
            continue
    if len(points) <= limit:
        return points
    step = max(1, len(points) // limit)
    sampled = points[::step]
    if sampled[-1] != points[-1]:
        sampled.append(points[-1])
    return sampled[:limit]


def build_backtest_settings(initial_balance: float, date_from: str, date_to: str) -> dict:
    return {
        "initialBalance": initial_balance,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "dateFrom": date_from,
        "dateTo": date_to,
    }


def build_dca_payload(
    *,
    api_key: str,
    system_name: str,
    date_from: str,
    date_to: str,
    initial_balance: float,
) -> dict:
    return {
        "systemName": system_name,
        "setKey": SET_KEY,
        "apiKeyName": api_key or None,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": initial_balance,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": DCA_BASE_PERCENT,
        "dcaInterval": DCA_INTERVAL,
        "dcaStepPercent": DCA_STEP,
        "dcaMaxOrders": DCA_MAX_ORDERS,
        "dcaTpPercent": DCA_TP,
        "dcaSlPercent": 0,
        "dcaEntryFilter": "always",
        "dcaReentryBars": 0,
        "dcaPerLegSl": False,
        "dcaAutotune": True,
        "maxCandidates": MAX_CANDIDATES,
        "dcaForceRefresh": True,
    }


def build_snapshot_patch(
    *,
    trend_offers: list[str],
    api_key: str,
    system_name: str,
    c_sum: dict,
    combined: dict,
    initial_balance: float,
    date_from: str,
    date_to: str,
    markets: list[str],
    tuning: dict,
) -> dict:
    equity = extract_equity_points((combined.get("combined") or {}).get("equity"))
    trades = int(c_sum.get("tradesCount") or 0)
    return {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": trend_offers,
        "apiKeyName": api_key,
        "systemName": system_name,
        "ret": float(c_sum.get("totalReturnPercent") or 0),
        "pf": float(c_sum.get("profitFactor") or 0),
        "dd": float(c_sum.get("maxDrawdownPercent") or 0),
        "trades": trades,
        "finalEquity": float(c_sum.get("finalEquity") or initial_balance),
        "periodDays": PERIOD_DAYS,
        "winRate": float(c_sum.get("winRatePercent") or 0),
        "tradesPerDay": round(trades / max(1, PERIOD_DAYS), 3),
        "equityPoints": equity,
        "backtestSettings": build_backtest_settings(initial_balance, date_from, date_to),
    }


def enable_storefront_vitrine(system_name: str) -> int:
    if not os.path.isfile(DB_PATH):
        print(f"WARN: DB not found at {DB_PATH}, skip vitrine SQL")
        return 0
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    profiles = cur.execute("SELECT id FROM algofund_profiles").fetchall()
    enabled = 0
    for (profile_id,) in profiles:
        cur.execute(
            """
            INSERT INTO algofund_active_systems
              (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
            VALUES (?, ?, 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (profile_id, system_name) DO UPDATE SET
              is_enabled = 1,
              assigned_by = 'admin',
              updated_at = CURRENT_TIMESTAMP
            """,
            (profile_id, system_name),
        )
        enabled += 1
    conn.commit()
    conn.close()
    return enabled


def publish_to_storefront(
    *,
    trend_offers: list[str],
    api_key: str,
    dca_payload: dict,
    markets: list[str],
    tuning: dict,
    combined: dict,
    c_sum: dict,
    initial_balance: float,
    date_from: str,
    date_to: str,
    store: dict,
    update_existing: bool = False,
) -> str:
    print("\n=== Publish TS to runtime + vitrine ===")
    system_name = EXISTING_SYSTEM_NAME if update_existing and EXISTING_SYSTEM_NAME else ""
    if not system_name:
        members = []
        offers_by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
        for offer_id in trend_offers:
            offer = offers_by_id.get(offer_id) or {}
            strategy_id = int(offer.get("strategyId") or 0)
            if strategy_id <= 0:
                continue
            members.append({
                "strategyId": strategy_id,
                "strategyName": str(offer.get("titleRu") or offer_id),
                "strategyType": "DD_BattleToads",
                "marketMode": "mono" if offer.get("mode") != "synth" else "synthetic",
                "market": str(offer.get("market") or ""),
                "score": float(offer.get("score") or 0),
                "weight": round(1 / max(1, len(trend_offers)), 4),
            })
        if len(members) < 3:
            raise RuntimeError(f"Need >=3 draft members for publish, got {len(members)}")
        api_post("/api/saas/admin/curated-draft-members", {"members": members}, timeout=120)
        print(f"  curated draft seeded: {len(members)} members")
        publish = api_post("/api/saas/admin/publish", {
            "offerIds": trend_offers,
            "setKey": SET_KEY,
            "editInPlace": True,
        }, timeout=300)
        system_name = str((publish.get("sourceSystem") or {}).get("systemName") or "").strip()
        if not system_name:
            raise RuntimeError(f"Publish did not return systemName: {publish}")
    else:
        print(f"  update existing system: {system_name}")

    apply_payload = {
        **dca_payload,
        "systemName": system_name,
        "markets": markets,
        "marketTuning": tuning,
        "maxApply": DCA_MARKETS,
    }
    applied = api_post("/api/saas/admin/ts-dca-pair-apply", apply_payload, timeout=600)
    print(f"  DCA applied: {len(applied.get('applied') or [])} markets")

    snapshot = build_snapshot_patch(
        trend_offers=trend_offers,
        api_key=api_key,
        system_name=system_name,
        c_sum=c_sum,
        combined=combined,
        initial_balance=initial_balance,
        date_from=date_from,
        date_to=date_to,
        markets=markets,
        tuning=tuning,
    )

    current_published = list(store.get("algofundPublishedSystemNames") or [])
    next_published = list(dict.fromkeys([system_name, *current_published]))

    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {
            SET_KEY: snapshot,
            system_name: snapshot,
        },
        "algofundPublishedSystemNames": next_published,
    })
    vitrine_rows = enable_storefront_vitrine(system_name)
    print(f"  vitrine enabled for {vitrine_rows} algofund profiles")
    print(f"  algofundPublishedSystemNames += {system_name}")
    return system_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Save TS snapshot to offer store")
    parser.add_argument("--publish", action="store_true", help="Publish card to Algofund vitrine (implies --apply)")
    parser.add_argument(
        "--update-existing",
        action="store_true",
        help=f"Apply DCA to existing system ({EXISTING_SYSTEM_NAME}) instead of new publish",
    )
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    end = datetime.now(timezone.utc).date()
    date_from = DATE_FROM_OVERRIDE or (end - timedelta(days=PERIOD_DAYS)).isoformat()
    date_to = end.isoformat()

    print(
        f"SUPER preset: risk={RISK_SCORE} dcaBase={DCA_BASE_PERCENT}% "
        f"step={DCA_STEP} maxOrders={DCA_MAX_ORDERS} markets={DCA_MARKETS}"
    )
    print(f"Loading offer store from {API}...")
    store = api_get("/api/saas/admin/offer-store")
    trend_offers, base_ts = pick_trend_offers(store)
    base_set_key = str(base_ts.get("setKey") or "balanced-portfolio-v2")
    print(f"Base snapshot: {base_set_key}")
    print(f"Trend protection offers ({len(trend_offers)}): {', '.join(trend_offers[:5])}...")

    api_key = base_ts.get("apiKeyName") or "BTDD_D1"
    initial_balance = INITIAL_BALANCE
    draft_system_name = f"ALGOFUND_MASTER::BTDD_D1::{SET_KEY}"

    seed_resp = requests.patch(f"{API}/api/saas/admin/offer-store", headers=HEADERS, json={
        "tsBacktestSnapshotsPatch": {
            SET_KEY: {
                "setKey": SET_KEY,
                "displayLabel": DISPLAY_LABEL,
                "offerIds": trend_offers,
                "apiKeyName": api_key,
                "systemName": draft_system_name,
                "ret": 0,
                "pf": 0,
                "dd": 0,
                "trades": 0,
                "periodDays": PERIOD_DAYS,
                "backtestSettings": build_backtest_settings(initial_balance, date_from, date_to),
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
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "preferRealBacktest": True,
    }, timeout=300)
    ts_summary = (ts_preview.get("preview") or {}).get("summary") or ts_preview.get("rerun") or {}
    print(
        f"  TS ret={ts_summary.get('totalReturnPercent')} "
        f"dd={ts_summary.get('maxDrawdownPercent')} "
        f"trades={ts_summary.get('tradesCount')}"
    )

    dca_payload = build_dca_payload(
        api_key=api_key,
        system_name=draft_system_name,
        date_from=date_from,
        date_to=date_to,
        initial_balance=initial_balance,
    )

    print("\n=== SUPER DCA scan ===")
    api_post("/api/saas/admin/ts-dca-pair-research", dca_payload, timeout=60)
    scan = poll_dca_scan()
    candidates = list(scan.get("candidates") or [])
    markets = pick_dca_markets(candidates)
    top_ret = sorted(
        [c for c in candidates if c.get("status") == "ok"],
        key=lambda c: float(c.get("ret") or 0),
        reverse=True,
    )[:8]
    print("  top scan by ret:", [(c.get("market"), c.get("ret"), c.get("dd")) for c in top_ret])
    print(f"  viable={scan.get('viableCount')} picked={markets}")
    if not markets:
        raise RuntimeError("No viable DCA markets from SUPER scan")

    tuning = {}
    by_market = {str(c.get("market") or "").upper(): c for c in candidates}
    for market in markets:
        row = by_market.get(market) or {}
        tuning[market] = {
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
        "preset": {
            "riskScore": RISK_SCORE,
            "dcaBasePercent": DCA_BASE_PERCENT,
            "dcaMarkets": DCA_MARKETS,
        },
        "trendOfferIds": trend_offers,
        "dcaMarkets": markets,
        "dcaTuning": tuning,
        "tsOnly": t_sum,
        "dcaOnly": d_sum,
        "combined": c_sum,
        "delta": combined.get("delta"),
    }
    out_path = f"/tmp/{SET_KEY}_research_{date_to}.json"
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
    print(f"\nReport saved: {out_path}")

    if not args.apply:
        print("\nDry-run complete. Re-run with --apply or --publish.")
        return

    snapshot = build_snapshot_patch(
        trend_offers=trend_offers,
        api_key=api_key,
        system_name=draft_system_name,
        c_sum=c_sum,
        combined=combined,
        initial_balance=initial_balance,
        date_from=date_from,
        date_to=date_to,
        markets=markets,
        tuning=tuning,
    )
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot},
    })
    print(f"Snapshot patched via offer-store: {SET_KEY}")

    if args.publish:
        published_name = publish_to_storefront(
            trend_offers=trend_offers,
            api_key=api_key,
            dca_payload=dca_payload,
            markets=markets,
            tuning=tuning,
            combined=combined,
            c_sum=c_sum,
            initial_balance=initial_balance,
            date_from=date_from,
            date_to=date_to,
            store=store,
            update_existing=args.update_existing,
        )
        report["publishedSystemName"] = published_name
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2)
        print(f"\nPublished to vitrine: {published_name}")


if __name__ == "__main__":
    main()

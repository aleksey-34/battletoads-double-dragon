#!/usr/bin/env python3
"""
Patch Synth Stable Union v4.2 — replace 3 legs unavailable on WEEX/BingX.

  BERAUSDT/IPUSDT  → RENDERUSDT/FETUSDT
  STXUSDT/IMXUSDT  → FETUSDT/OPUSDT
  TRUUSDT/GRTUSDT  → ORDIUSDT/PYTHUSDT

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/patch_v42_weex_legs_jul2026.py --compare
  ... --apply --publish --rematerialize
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

CARD_IN = os.path.join(REPO, "results/synth_stable_union_card_v4.2_jul2026.json")
CARD_OUT = os.path.join(REPO, "results/synth_stable_union_card_v4.2_weex_jul2026.json")
COMPARE_OUT = os.path.join(REPO, "results/v42_weex_leg_swap_compare_jul2026.json")
TARGET_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-2-jul2026-zbhya"
SET_KEY = "synth-stable-union-v4.2-jul2026"

LOT_PERCENT = 22
MAX_OPEN_POSITIONS = 15
REINVEST_PERCENT = 50
INITIAL_BALANCE = 10_000
DATE_FROM = "2023-07-01"
DATE_TO = "2025-06-30"
API_KEY = "BTDD_D1"

PORTFOLIO_CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}

REPLACEMENTS = [
    {
        "removeMarket": "BERAUSDT/IPUSDT",
        "addMarket": "RENDERUSDT/FETUSDT",
        "strategyId": 242967,
        "tier": "4h_ct",
        "reason": "IPUSDT not listed on WEEX/BingX futures",
    },
    {
        "removeMarket": "STXUSDT/IMXUSDT",
        "addMarket": "FETUSDT/OPUSDT",
        "strategyId": 242971,
        "tier": "4h_ct",
        "reason": "STXUSDT not listed on WEEX futures",
    },
    {
        "removeMarket": "TRUUSDT/GRTUSDT",
        "addMarket": "ORDIUSDT/PYTHUSDT",
        "strategyId": 242975,
        "tier": "4h_ct",
        "reason": "TRUUSDT not listed on WEEX/BingX futures",
    },
]


def api_post(path: str, payload: dict | None = None, timeout: int = 600) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload or {}, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:800]}")
    return r.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:800]}")
    return r.json()


def api_get(path: str, timeout: int = 120) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:800]}")
    return r.json()


def load_strategy(conn: sqlite3.Connection, sid: int) -> dict:
    row = conn.execute(
        """
        SELECT id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval
        FROM strategies WHERE id=?
        """,
        (sid,),
    ).fetchone()
    if not row:
        raise RuntimeError(f"strategy {sid} not found in DB")
    cols = ["id", "name", "strategy_type", "market_mode", "base_symbol", "quote_symbol", "interval"]
    data = dict(zip(cols, row))
    b, q = data["base_symbol"], data["quote_symbol"]
    market = b if not q else f"{b}/{q}"
    mode = "mono" if str(data["market_mode"]).lower() == "mono" else "synthetic"
    return {
        "strategyId": int(data["id"]),
        "strategyName": str(data["name"]),
        "strategyType": str(data["strategy_type"]),
        "marketMode": mode,
        "market": market,
        "interval": str(data["interval"] or "4h"),
        "tier": "4h_ct",
        "legLotMult": 1.0,
        "tunedLotPct": 100,
    }


def apply_replacements(members: list[dict], conn: sqlite3.Connection) -> tuple[list[dict], list[dict]]:
    remove_markets = {r["removeMarket"] for r in REPLACEMENTS}
    out = [m for m in members if str(m.get("market") or "").upper() not in remove_markets]
    swap_log: list[dict] = []
    existing_ids = {int(m["strategyId"]) for m in out if m.get("strategyId")}
    for rep in REPLACEMENTS:
        leg = load_strategy(conn, int(rep["strategyId"]))
        leg["tier"] = rep["tier"]
        leg["replaceReason"] = rep["reason"]
        if leg["strategyId"] in existing_ids:
            raise RuntimeError(f"duplicate strategyId after swap: {leg['strategyId']}")
        out.append(leg)
        swap_log.append({
            "removed": rep["removeMarket"],
            "added": rep["addMarket"],
            "strategyId": leg["strategyId"],
            "strategyName": leg["strategyName"],
            "reason": rep["reason"],
        })
        existing_ids.add(leg["strategyId"])
    if len(out) != len(members):
        raise RuntimeError(f"leg count changed: {len(members)} -> {len(out)}")
    return out, swap_log


def assign_weights(members: list[dict]) -> None:
    w = round(1.0 / max(1, len(members)), 6)
    for m in members:
        m["weight"] = w


def portfolio_preview(members: list[dict]) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    mul = {
        str(m["strategyId"]): float(m.get("effectiveMult") or m.get("legLotMult") or 1.0)
        for m in members
    }
    growth = min(20.0, 1.0 + (REINVEST_PERCENT / 100.0) * 19.0) if REINVEST_PERCENT > 0 else 0
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": INITIAL_BALANCE,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "lotPercentOverride": LOT_PERCENT,
        "maxDepositOverride": INITIAL_BALANCE * growth if growth else 0,
        "reinvestPercentOverride": REINVEST_PERCENT,
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": PORTFOLIO_CB,
    }
    data = api_post("/api/backtest/run", payload, timeout=900)
    if not data.get("success"):
        raise RuntimeError(data.get("error") or "backtest failed")
    result = data.get("result") or {}
    summary = result.get("summary") or result
    return {
        "totalReturnPercent": float(summary.get("totalReturnPercent") or summary.get("ret") or 0),
        "maxDrawdownPercent": float(summary.get("maxDrawdownPercent") or summary.get("dd") or 0),
        "profitFactor": float(summary.get("profitFactor") or summary.get("pf") or 0),
        "tradesCount": int(summary.get("tradesCount") or summary.get("trades") or 0),
        "legs": len(members),
    }


def offer_id(m: dict) -> str:
    mode = "mono" if m.get("marketMode") == "mono" else "synth"
    st = str(m.get("strategyType") or "").lower()
    return f"offer_{mode}_{st}_{m['strategyId']}"


def sync_new_offers(members: list[dict], store: dict) -> list[str]:
    by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
    patch_offers: list[dict] = []
    for m in members:
        oid = offer_id(m)
        if oid in by_id:
            continue
        sid = int(m["strategyId"])
        st = str(m.get("strategyType") or "")
        market = str(m.get("market") or "")
        iv = str(m.get("interval") or "4h")
        mode = "mono" if m.get("marketMode") == "mono" else "synthetic"
        preset = {"strategyId": sid, "strategyName": m.get("strategyName"), "params": {"interval": iv}}
        patch_offers.append({
            "offerId": oid,
            "titleRu": f"SYNTH • {st} • {market} • {iv}",
            "descriptionRu": "v4.2 WEEX/BingX leg replacement",
            "strategy": {"id": sid, "name": m.get("strategyName"), "type": st, "mode": mode, "market": market, "params": {"interval": iv}},
            "metrics": {"ret": 0, "pf": 1, "dd": 0, "trades": 0, "score": 0},
            "sliderPresets": {"risk": {"medium": preset}, "tradeFrequency": {"medium": preset}},
            "presetMatrix": {"medium": {"medium": preset}},
        })
    if patch_offers:
        api_patch("/api/saas/admin/offer-store", {"offersPatch": patch_offers})
    return [offer_id(m) for m in members]


def publish_card(members: list[dict], snapshot: dict) -> str:
    draft_members = [{
        "strategyId": int(m["strategyId"]),
        "strategyName": str(m.get("strategyName") or ""),
        "strategyType": str(m.get("strategyType") or ""),
        "marketMode": str(m.get("marketMode") or "synthetic"),
        "market": str(m.get("market") or ""),
        "score": float(m.get("tunedRetEst") or 0),
        "weight": float(m.get("weight") or round(1.0 / len(members), 4)),
    } for m in members]
    api_post("/api/saas/admin/curated-draft-members", {"members": draft_members}, timeout=120)
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = sync_new_offers(members, store)
    publish = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": True,
    }, timeout=300)
    system_name = str((publish.get("sourceSystem") or {}).get("systemName") or TARGET_SYSTEM).strip()
    store = api_get("/api/saas/admin/offer-store")
    snapshot = {**snapshot, "systemName": system_name}
    published = list(store.get("algofundPublishedSystemNames") or [])
    next_published = list(dict.fromkeys([system_name, *published]))
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": next_published,
    })
    return system_name


def sync_master_card(conn: sqlite3.Connection, ts_id: int, members: list[dict]) -> None:
    card_code = f"CARD::{TARGET_SYSTEM.upper()}"
    meta = {
        "lotPercentOverride": LOT_PERCENT,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "reinvestPercentOverride": REINVEST_PERCENT,
        "dcaLayersRequired": False,
        "expectedMemberCount": 20,
        "portfolioCircuitBreaker": PORTFOLIO_CB,
        "displayLabel": "Synth Stable Union v4.2 (+ TV 15m burst, WEEX legs)",
        "category": "synth-stable-v42",
        "weexLegPatch": "jul2026",
    }
    conn.execute(
        """
        INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
        VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(code) DO UPDATE SET
          metadata_json = excluded.metadata_json,
          updated_at = CURRENT_TIMESTAMP
        """,
        (card_code, meta["displayLabel"], "v4.2 WEEX/BingX leg patch", ts_id, json.dumps(meta)),
    )
    card_id = conn.execute("SELECT id FROM master_cards WHERE code=?", (card_code,)).fetchone()[0]
    conn.execute("DELETE FROM master_card_members WHERE card_id=?", (card_id,))
    w = round(1.0 / max(1, len(members)), 6)
    for m in members:
        conn.execute(
            """
            INSERT INTO master_card_members (card_id, strategy_id, weight, member_role, is_enabled, notes, created_at)
            VALUES (?, ?, ?, 'core', 1, ?, CURRENT_TIMESTAMP)
            """,
            (card_id, int(m["strategyId"]), w, "weex-patch-jul2026"),
        )
    conn.commit()


def rematerialize_v42_clients(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """
        SELECT t.id, t.slug, COUNT(m.id) AS members
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        LEFT JOIN trading_systems ts ON ts.name = 'ALGOFUND::' || t.slug
        LEFT JOIN trading_system_members m ON m.system_id = ts.id
        WHERE ap.published_system_name = ?
          AND COALESCE(ap.actual_enabled, 0) = 1
        GROUP BY t.id, t.slug
        ORDER BY t.slug
        """,
        (TARGET_SYSTEM,),
    ).fetchall()
    summary: list[dict] = []
    for tid, slug, before in rows:
        print(f"rematerialize {slug} ({tid})...", flush=True)
        try:
            api_post(f"/api/saas/algofund/{tid}/retry-materialize", {}, timeout=900)
            after = conn.execute(
                """
                SELECT COUNT(*) FROM trading_system_members m
                JOIN trading_systems ts ON ts.id = m.system_id
                WHERE ts.name = ?
                """,
                (f"ALGOFUND::{slug}",),
            ).fetchone()[0]
            summary.append({"slug": slug, "tenantId": tid, "ok": True, "before": before, "after": after})
            print(f"  ✓ {before} -> {after} members", flush=True)
        except Exception as exc:
            summary.append({"slug": slug, "tenantId": tid, "ok": False, "error": str(exc), "before": before})
            print(f"  FAIL {exc}", flush=True)
        time.sleep(1)
    return summary


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--compare", action="store_true", help="Run before/after portfolio backtest")
    parser.add_argument("--apply", action="store_true", help="Write patched card JSON")
    parser.add_argument("--publish", action="store_true", help="Publish patched card in-place")
    parser.add_argument("--rematerialize", action="store_true", help="Retry materialize all v4.2 clients")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    if not os.path.isfile(CARD_IN):
        raise SystemExit(f"Missing card: {CARD_IN}")

    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    card = json.load(open(CARD_IN, encoding="utf-8"))
    before_members = list(card.get("members") or [])
    after_members, swap_log = apply_replacements(before_members, conn)
    assign_weights(after_members)

    print("Leg swaps:")
    for row in swap_log:
        print(f"  {row['removed']} → {row['added']} (sid={row['strategyId']})")

    compare: dict = {"swaps": swap_log, "generatedAt": datetime.now(timezone.utc).isoformat()}
    if args.compare or args.publish:
        print("Running portfolio backtest (before)...")
        compare["before"] = portfolio_preview(before_members)
        print("Running portfolio backtest (after)...")
        compare["after"] = portfolio_preview(after_members)
        b, a = compare["before"], compare["after"]
        compare["delta"] = {
            "returnPct": round(a["totalReturnPercent"] - b["totalReturnPercent"], 2),
            "ddPct": round(a["maxDrawdownPercent"] - b["maxDrawdownPercent"], 2),
            "pf": round(a["profitFactor"] - b["profitFactor"], 3),
            "trades": a["tradesCount"] - b["tradesCount"],
        }
        json.dump(compare, open(COMPARE_OUT, "w"), indent=2, ensure_ascii=False)
        print(f"Comparison saved → {COMPARE_OUT}")
        print(
            f"  ret {b['totalReturnPercent']:.1f}% → {a['totalReturnPercent']:.1f}% "
            f"(Δ{compare['delta']['returnPct']:+.1f})"
        )
        print(
            f"  dd  {b['maxDrawdownPercent']:.1f}% → {a['maxDrawdownPercent']:.1f}% "
            f"(Δ{compare['delta']['ddPct']:+.1f})"
        )

    patched_card = {
        **card,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "weexLegPatch": swap_log,
        "members": after_members,
        "composition": {"legsTotal": len(after_members)},
    }
    json.dump(patched_card, open(CARD_OUT, "w"), indent=2, ensure_ascii=False)
    print(f"Patched card → {CARD_OUT}")

    if args.apply:
        json.dump(patched_card, open(CARD_IN, "w"), indent=2, ensure_ascii=False)
        print(f"Updated {CARD_IN}")

    if args.publish:
        ts_row = conn.execute("SELECT id FROM trading_systems WHERE name=?", (TARGET_SYSTEM,)).fetchone()
        if not ts_row:
            raise SystemExit(f"TS not found: {TARGET_SYSTEM}")
        ts_id = int(ts_row[0])
        snapshot = {
            "systemName": TARGET_SYSTEM,
            "setKey": SET_KEY,
            "summary": compare.get("after") or {},
            "legCount": len(after_members),
            "weexLegPatch": swap_log,
        }
        system_name = publish_card(after_members, snapshot)
        sync_master_card(conn, ts_id, after_members)
        print(f"Published in-place → {system_name}")

    if args.rematerialize:
        summary = rematerialize_v42_clients(conn)
        compare["rematerialize"] = summary
        json.dump(compare, open(COMPARE_OUT, "w"), indent=2, ensure_ascii=False)
        ok = sum(1 for r in summary if r.get("ok"))
        full = sum(1 for r in summary if r.get("after") == 20)
        print(f"Rematerialized {ok}/{len(summary)} clients, {full} at 20/20")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Personal TV Burst TURBO card — mono momentum_scalp_tv cloud only (Yakov).

Reads sizing grid from research_tv_burst_turbo_jul2026.py or env overrides.

  python3 scripts/hybrid/build_tv_burst_turbo_card_jul2026.py
  PUBLISH=1 python3 scripts/hybrid/build_tv_burst_turbo_card_jul2026.py
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
GRID_PATH = os.path.join(REPO, "results", "tv_burst_turbo", "tv_burst_turbo_sizing_grid_jul2026.json")
CARD_OUT = os.path.join(REPO, "results", "tv_burst_turbo_card_jul2026.json")

API_KEY = "BTDD_D1"
SET_KEY = os.environ.get("TURBO_SET_KEY", "tv-burst-turbo-yakov-jul2026")
DISPLAY_LABEL = os.environ.get("TURBO_DISPLAY", "TV Burst TURBO 15m (personal)")
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL_BALANCE = float(os.environ.get("TURBO_INITIAL", "10000"))
LOT_PERCENT = float(os.environ.get("TURBO_LOT", "45"))
MAX_OPEN_POSITIONS = int(os.environ.get("TURBO_OP", "10"))
REINVEST_PERCENT = float(os.environ.get("TURBO_REINVEST", "100"))
RISK_SCORE = float(os.environ.get("TURBO_RISK_SCORE", "8.5"))
TRADE_FREQ = float(os.environ.get("TURBO_TRADE_FREQ", "9"))

CORE_MARKETS = ["SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT"]
BURST_PRESET = {"emaFast": 8, "emaSlow": 21, "adxMin": 20, "tpPercent": 2.0, "slPercent": 1.2}


def api_get(path: str) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=120)
    return r.json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    data = r.json()
    if data.get("success") is False or data.get("error"):
        raise RuntimeError(data.get("error") or str(data)[:400])
    return data


def api_patch(path: str, payload: dict) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=120)
    return r.json()


def ensure_tv_strategy(conn: sqlite3.Connection, base: str) -> int:
    name = f"TV_BURST_15M_{base}"
    row = conn.execute(
        """SELECT s.id FROM strategies s
           JOIN api_keys ak ON ak.id = s.api_key_id
           WHERE ak.name = ? AND s.name = ?""",
        (API_KEY, name),
    ).fetchone()
    if row:
        return int(row[0])
    ak = conn.execute("SELECT id FROM api_keys WHERE name=?", (API_KEY,)).fetchone()
    if not ak:
        raise SystemExit(f"api_key {API_KEY} not found")
    conn.execute(
        """INSERT INTO strategies (
            name, api_key_id, strategy_type, market_mode, base_symbol, quote_symbol, interval,
            price_channel_length, zscore_entry, zscore_exit, zscore_stop, take_profit_percent,
            long_enabled, short_enabled, lot_long_percent, lot_short_percent, is_active,
            display_on_chart, show_settings, show_chart, show_indicators, show_positions_on_chart,
            auto_update, reinvest_percent, leverage, margin_type, detection_source, state
        ) VALUES (?, ?, 'momentum_scalp_tv', 'mono', ?, '', '15m',
            8, 21, 20, 1.2, 2.0, 1, 1, 100, 100, 0, 0, 1, 0, 0, 0, 1, 100, 20, 'cross', 'close', 'flat')""",
        (name, int(ak[0]), base),
    )
    conn.commit()
    return int(
        conn.execute("SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, int(ak[0]))).fetchone()[0]
    )


def load_recommended() -> dict:
    if os.path.isfile(GRID_PATH):
        grid = json.load(open(GRID_PATH, encoding="utf-8"))
        rec = grid.get("recommended") or {}
        if rec:
            return rec
    return {
        "markets": CORE_MARKETS,
        "lotPercent": LOT_PERCENT,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "reinvestPercent": REINVEST_PERCENT,
    }


def build_members(conn: sqlite3.Connection, markets: list[str]) -> list[dict]:
    members: list[dict] = []
    for base in markets:
        sid = ensure_tv_strategy(conn, base)
        members.append({
            "strategyId": sid,
            "strategyName": f"TV_BURST_15M_{base}",
            "strategyType": "momentum_scalp_tv",
            "marketMode": "mono",
            "market": base,
            "interval": "15m",
            "tier": "burst_15m_tv",
            "legLotMult": 1.0,
            "effectiveMult": 1.0,
            "tunedLotPct": 100,
            "burstPreset": BURST_PRESET,
        })
    return members


def portfolio_preview(members: list[dict], lot: float, op: int, reinvest: float) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    mul = {str(int(m["strategyId"])): float(m.get("legLotMult") or 1.0) for m in members}
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0
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
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL_BALANCE * growth if growth else 0,
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
    }
    return api_post("/api/backtest/run", payload).get("result") or {}


def offer_id(m: dict) -> str:
    return f"tv-burst-turbo-{int(m['strategyId'])}"


def build_catalog_offer(m: dict, metrics: dict) -> dict:
    sid = int(m["strategyId"])
    st = str(m.get("strategyType") or "")
    market = str(m.get("market") or "")
    iv = str(m.get("interval") or "15m")
    oid = offer_id(m)
    name = str(m.get("strategyName") or f"Strategy {sid}")
    preset = {
        "strategyId": sid,
        "strategyName": name,
        "metrics": metrics,
        "params": {"interval": iv, **BURST_PRESET},
    }
    return {
        "offerId": oid,
        "titleRu": f"TV Burst • {market} • {iv}",
        "descriptionRu": "TV EMA+ADX momentum scalp mono 15m (personal turbo card).",
        "strategy": {"id": sid, "name": name, "type": st, "mode": "mono", "market": market, "params": {"interval": iv}},
        "metrics": {**metrics, "score": metrics.get("ret", 0)},
        "sliderPresets": {"risk": {"high": preset}, "tradeFrequency": {"high": preset}},
        "presetMatrix": {"high": {"high": preset}},
    }


def sync_offers_to_store(members: list[dict], snapshot: dict) -> list[str]:
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = [offer_id(m) for m in members]
    offers = list(store.get("offers") or [])
    by_id = {str(o.get("offerId")): o for o in offers}
    per_leg_metrics = {
        "ret": round(snapshot.get("ret", 0) / max(1, len(members)), 1),
        "dd": snapshot.get("dd", 0),
        "pf": snapshot.get("pf", 1),
        "trades": int(snapshot.get("trades", 0) / max(1, len(members))),
    }
    patch_offers: list[dict] = []
    for m in members:
        oid = offer_id(m)
        if oid not in by_id:
            patch_offers.append(build_catalog_offer(m, per_leg_metrics))
    if patch_offers:
        api_patch("/api/saas/admin/offer-store", {"offersPatch": patch_offers})
        print(f"synced {len(patch_offers)} offers")
    return offer_ids


def enable_storefront_vitrine(system_name: str) -> int:
    if not os.path.isfile(DB):
        return 0
    conn = sqlite3.connect(DB)
    profiles = conn.execute("SELECT id FROM algofund_profiles").fetchall()
    enabled = 0
    for (profile_id,) in profiles:
        conn.execute(
            """
            INSERT INTO algofund_active_systems
              (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
            VALUES (?, ?, 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (profile_id, system_name) DO UPDATE SET
              is_enabled = 1, assigned_by = 'admin', updated_at = CURRENT_TIMESTAMP
            """,
            (profile_id, system_name),
        )
        enabled += 1
    conn.commit()
    conn.close()
    return enabled


def build_snapshot(preview: dict, lot: float, op: int, reinvest: float, members: list[dict], offer_ids: list[str], system_name: str = "") -> dict:
    s = preview.get("summary") or {}
    try:
        d1 = datetime.strptime(DATE_FROM[:10], "%Y-%m-%d").date()
        d2 = datetime.strptime(DATE_TO[:10], "%Y-%m-%d").date()
        period_days = max(1, (d2 - d1).days)
    except ValueError:
        period_days = 760
    trades = int(s.get("tradesCount") or 0)
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0
    lot_mults = {str(int(m["strategyId"])): float(m.get("legLotMult") or 1.0) for m in members}
    return {
        "kind": "algofund-ts",
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "apiKeyName": API_KEY,
        "systemName": system_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": trades,
        "tradesPerDay": round(trades / period_days, 2),
        "periodDays": period_days,
        "initialBalance": INITIAL_BALANCE,
        "finalEquity": round(float(s.get("finalEquity") or INITIAL_BALANCE), 2),
        "legs": len(members),
        "cardType": "tv_burst_turbo_mono",
        "backtestSettings": {
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": INITIAL_BALANCE,
            "riskScore": RISK_SCORE,
            "tradeFrequencyScore": TRADE_FREQ,
            "lotPercent": lot,
            "lotPercentOverride": lot,
            "maxOpenPositions": op,
            "reinvestPercent": reinvest,
            "maxDepositOverride": INITIAL_BALANCE * growth if growth else 0,
            "lotPercentMultiplierByStrategyId": lot_mults,
            "enablePairLock": True,
            "portfolioCircuitBreaker": None,
        },
    }


def publish_card(members: list[dict], snapshot: dict) -> str:
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = sync_offers_to_store(members, snapshot)
    snapshot = build_snapshot(
        {"summary": {
            "totalReturnPercent": snapshot["ret"],
            "maxDrawdownPercent": snapshot["dd"],
            "profitFactor": snapshot["pf"],
            "tradesCount": snapshot["trades"],
            "finalEquity": snapshot["finalEquity"],
        }},
        snapshot["backtestSettings"]["lotPercent"],
        snapshot["backtestSettings"]["maxOpenPositions"],
        snapshot["backtestSettings"]["reinvestPercent"],
        members,
        offer_ids,
    )
    draft_members = [{
        "strategyId": int(m["strategyId"]),
        "strategyName": m["strategyName"],
        "strategyType": m["strategyType"],
        "marketMode": m["marketMode"],
        "market": m["market"],
        "score": snapshot.get("ret", 0),
        "weight": round(1.0 / max(1, len(members)), 4),
    } for m in members]
    api_post("/api/saas/admin/curated-draft-members", {"members": draft_members}, timeout=120)
    pub = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": False,
    }, timeout=300)
    system_name = str((pub.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"publish failed: {pub}")
    snapshot["systemName"] = system_name
    published = list(store.get("algofundPublishedSystemNames") or [])
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    rows = enable_storefront_vitrine(system_name)
    print(f"vitrine enabled for {rows} profiles")
    return system_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--publish", action="store_true", help="Publish to storefront (new card)")
    args = parser.parse_args()
    publish = args.publish or os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes")

    rec = load_recommended()
    markets = list(rec.get("markets") or CORE_MARKETS)
    lot = float(rec.get("lotPercent") or 40)
    op = int(rec.get("maxOpenPositions") or 8)
    reinvest = float(rec.get("reinvestPercent") or 75)

    conn = sqlite3.connect(DB)
    members = build_members(conn, markets)
    preview = portfolio_preview(members, lot, op, reinvest)
    s = preview.get("summary") or {}
    offer_ids = [offer_id(m) for m in members]
    snapshot = build_snapshot(preview, lot, op, reinvest, members, offer_ids)

    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "cardVersion": "tv-burst-turbo-v1",
        "members": members,
        "composition": {
            "legsTotal": len(members),
            "burst15mTv": len(members),
            "markets": markets,
        },
        "settings": {
            "lotPercent": lot,
            "maxOpenPositions": op,
            "reinvestPercent": reinvest,
            "initialBalance": INITIAL_BALANCE,
            "enablePairLock": True,
            "portfolioCircuitBreaker": None,
        },
        "preview": {
            "ret": snapshot["ret"],
            "dd": snapshot["dd"],
            "pf": snapshot["pf"],
            "trades": snapshot["trades"],
            "finalEquity": snapshot["finalEquity"],
        },
        "snapshot": snapshot,
        "marginNotes": {
            "leverage": 20,
            "slPercent": 1.2,
            "tpPercent": 2.0,
            "maxConcurrentLegs": min(op, len(markets)),
            "estimatedInitialMarginPct": round(min(op, len(markets)) * lot / 20, 1),
            "liquidationInBacktest": "not modeled — exits via SL 1.2% / TP 2% / EMA cross",
        },
    }
    os.makedirs(os.path.dirname(CARD_OUT), exist_ok=True)
    json.dump(card, open(CARD_OUT, "w", encoding="utf-8"), indent=2)

    print(f"TV Burst TURBO card: {len(members)} legs {markets}")
    print(f"  lot={lot}% OP={op} reinvest={reinvest}%")
    print(f"  ret={snapshot['ret']}% dd={snapshot['dd']}% trades={snapshot['trades']} pf={snapshot['pf']}")
    print(f"wrote {CARD_OUT}")

    if publish:
        system_name = publish_card(members, snapshot)
        print(f"PUBLISHED → {system_name}")
    else:
        print("dry-run (use PUBLISH=1 or --publish to push storefront)")


if __name__ == "__main__":
    main()

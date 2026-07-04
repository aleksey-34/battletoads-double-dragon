#!/usr/bin/env python3
"""
Synth Stable Union v4.4 — 16 synth + 20 Cloud Spread TV mono legs.

  PUBLISH=1 python3 scripts/hybrid/build_synth_stable_card_v44_jul2026.py
  V44_TV_MULT=1.0 V44_OP=24 PUBLISH=1 ...
"""
from __future__ import annotations

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
SWEEP = os.path.join(REPO, "results", "v44_cloud20_synth_overlay_jul2026.json")
CARD_OUT = os.path.join(REPO, "results", "synth_stable_union_card_v4.4_jul2026.json")

API_KEY = "BTDD_D1"
SET_KEY = "synth-stable-union-v4-4-jul2026"
DISPLAY_LABEL = "Synth Stable Union v4.4 (+ Cloud Spread 20 TV)"
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
LOT = 22.0
REINVEST = 50.0
INITIAL = 10000.0
RISK_SCORE = 4.5
TRADE_FREQ = 6.0

SYNTH_MULT = {
    218660: 0.5, 239276: 0.7, 239282: 0.7, 239292: 0.5,
    241565: 1.0, 241567: 1.0, 242965: 1.0, 242966: 1.0,
    242968: 0.7, 242969: 0.5, 242970: 0.7, 242972: 0.35,
    242973: 1.0, 242974: 0.5, 242976: 0.5, 242977: 0.7,
}
CLOUD20 = [
    "SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT", "WIFUSDT",
    "DYDXUSDT", "EIGENUSDT", "APTUSDT", "ARBUSDT", "ENAUSDT",
    "ATOMUSDT", "FILUSDT", "ALTUSDT", "IMXUSDT", "GRTUSDT",
    "IPUSDT", "BERAUSDT", "ICPUSDT", "APEUSDT", "DOTUSDT",
]
CB = {
    "enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8,
    "lotMultiplier": 0.5, "pauseDays": 14,
}


def api_get(path: str) -> dict:
    return requests.get(f"{API}{path}", headers=HEADERS, timeout=120).json()


def api_post(path: str, payload: dict, timeout: int = 1200) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    data = r.json()
    if data.get("success") is False or data.get("error"):
        raise RuntimeError(data.get("error") or str(data)[:400])
    return data


def api_patch(path: str, payload: dict) -> dict:
    return requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=120).json()


def ensure_tv(conn: sqlite3.Connection, base: str) -> int:
    name = f"TV_BURST_15M_{base}"
    row = conn.execute(
        "SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id WHERE ak.name=? AND s.name=?",
        (API_KEY, name),
    ).fetchone()
    if row:
        return int(row[0])
    ak = conn.execute("SELECT id FROM api_keys WHERE name=?", (API_KEY,)).fetchone()
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
    return int(conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()[0])


def load_params() -> tuple[float, int]:
    tv_mult = float(os.environ.get("V44_TV_MULT", "0"))
    op = int(os.environ.get("V44_OP", "0"))
    if os.path.isfile(SWEEP) and (tv_mult <= 0 or op <= 0):
        best = json.load(open(SWEEP, encoding="utf-8")).get("best") or {}
        tv_mult = tv_mult or float(best.get("tvMult") or 1.0)
        op = op or int(best.get("op") or 24)
    return float(tv_mult or 1.0), int(op or 24)


def cloud_symbols() -> list[str]:
    rank = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_cloud_spread_rank_jul2026.json")
    if os.path.isfile(rank):
        syms = json.load(open(rank, encoding="utf-8")).get("pickedSymbols") or []
        if len(syms) >= 20:
            return list(syms[:20])
    return list(CLOUD20)


def build_members(conn: sqlite3.Connection, tv_mult: float) -> list[dict]:
    members: list[dict] = []
    for sid, mult in SYNTH_MULT.items():
        row = conn.execute(
            "SELECT id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval FROM strategies WHERE id=?",
            (sid,),
        ).fetchone()
        if not row:
            continue
        market = f"{row[4]}/{row[5]}" if row[5] else row[4]
        members.append({
            "strategyId": int(row[0]), "strategyName": row[1], "strategyType": row[2],
            "marketMode": "mono" if str(row[3]).lower() == "mono" else "synthetic",
            "market": market, "interval": row[6], "tier": "synth_alpha",
            "legLotMult": mult, "effectiveMult": mult,
        })
    for sym in cloud_symbols():
        tid = ensure_tv(conn, sym)
        members.append({
            "strategyId": tid, "strategyName": f"TV_BURST_15M_{sym}", "strategyType": "momentum_scalp_tv",
            "marketMode": "mono", "market": sym, "interval": "15m", "tier": "burst_15m_tv",
            "legLotMult": tv_mult, "effectiveMult": tv_mult,
        })
    return members


def portfolio_preview(members: list[dict], op: int) -> dict:
    mul = {str(m["strategyId"]): float(m["effectiveMult"]) for m in members}
    payload = {
        "apiKeyName": API_KEY, "mode": "portfolio",
        "strategyIds": [int(m["strategyId"]) for m in members],
        "dateFrom": DATE_FROM, "dateTo": DATE_TO, "bars": 900, "warmupBars": 120,
        "initialBalance": INITIAL, "commissionPercent": 0.1, "slippagePercent": 0.05,
        "maxOpenPositions": op, "lotPercentOverride": LOT, "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": INITIAL * (1 + (REINVEST / 100) * 19),
        "lotPercentMultiplierByStrategyId": mul, "enablePairLock": True,
        "skipMissingSymbols": True, "portfolioCircuitBreaker": CB,
    }
    return api_post("/api/backtest/run", payload).get("result") or {}


def offer_id(m: dict) -> str:
    mode = "mono" if m.get("marketMode") == "mono" else "synth"
    return f"offer_{mode}_{m.get('strategyType', '').lower()}_{m['strategyId']}"


def publish(members: list[dict], snapshot: dict) -> str:
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = [offer_id(m) for m in members]
    draft = [{
        "strategyId": int(m["strategyId"]), "strategyName": m["strategyName"],
        "strategyType": m["strategyType"], "marketMode": m["marketMode"], "market": m["market"],
        "score": snapshot.get("ret", 0), "weight": round(1.0 / len(members), 4),
    } for m in members]
    api_post("/api/saas/admin/curated-draft-members", {"members": draft}, timeout=120)
    pub = api_post("/api/saas/admin/publish", {"offerIds": offer_ids, "setKey": SET_KEY, "editInPlace": False}, timeout=300)
    system_name = str((pub.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"publish failed: {pub}")
    snapshot["systemName"] = system_name
    published = list(store.get("algofundPublishedSystemNames") or [])
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    return system_name


def main() -> None:
    tv_mult, op = load_params()
    conn = sqlite3.connect(DB)
    members = build_members(conn, tv_mult)
    preview = portfolio_preview(members, op)
    s = preview.get("summary") or {}
    mul = {str(m["strategyId"]): float(m["effectiveMult"]) for m in members}
    snapshot = {
        "setKey": SET_KEY, "displayLabel": DISPLAY_LABEL,
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
        "backtestSettings": {
            "dateFrom": DATE_FROM, "dateTo": DATE_TO, "initialBalance": INITIAL,
            "riskScore": RISK_SCORE, "tradeFrequencyScore": TRADE_FREQ,
            "lotPercentOverride": LOT, "maxOpenPositions": op, "reinvestPercent": REINVEST,
            "maxDepositOverride": INITIAL * (1 + (REINVEST / 100) * 19),
            "lotPercentMultiplierByStrategyId": mul, "enablePairLock": True,
            "portfolioCircuitBreaker": CB, "backtestBars": 900, "warmupBars": 120,
        },
    }
    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "setKey": SET_KEY, "displayLabel": DISPLAY_LABEL, "cardVersion": "v4.4",
        "parentCard": "synth-stable-union-v4-3-jul2026",
        "cloudUpgrade": {"tvLegs": cloud_symbols(), "tvMult": tv_mult, "op": op},
        "members": members, "preview": snapshot,
    }
    json.dump(card, open(CARD_OUT, "w", encoding="utf-8"), indent=2)
    print(f"v4.4: {len(members)} legs (16 synth + {len(cloud_symbols())} TV) tvMult={tv_mult} OP={op}")
    print(f"  ret={snapshot['ret']}% dd={snapshot['dd']}% trades={snapshot['trades']} pf={snapshot['pf']}")
    print(f"wrote {CARD_OUT}")
    if os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes"):
        print(f"PUBLISHED → {publish(members, snapshot)}")


if __name__ == "__main__":
    main()

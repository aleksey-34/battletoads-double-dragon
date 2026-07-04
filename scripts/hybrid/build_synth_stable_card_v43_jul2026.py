#!/usr/bin/env python3
"""
Synth Stable Union v4.3 — CRV→TV momentum 15m + burst 3× on SUI/DOGE/SOL/CRV.
Synth alpha layer unchanged vs zbhya v4.2. New card slug (clients on zbhya untouched).

  PUBLISH=1 python3 scripts/hybrid/build_synth_stable_card_v43_jul2026.py
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
CARD_OUT = os.path.join(REPO, "results", "synth_stable_union_card_v4.3_jul2026.json")

API_KEY = "BTDD_D1"
SET_KEY = "synth-stable-union-v4-3-jul2026"
DISPLAY_LABEL = "Synth Stable Union v4.3 (+ TV burst 3× CRV/SUI/DOGE/SOL)"
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
LOT = 22.0
OP = 15
REINVEST = 50.0
INITIAL = 10000.0
BURST_MULT = float(os.environ.get("V43_BURST_MULT", "3"))
RISK_SCORE = 4.0
TRADE_FREQ = 5.0

# zbhya live snapshot leg mults (must match research_v42_burst_weight_overlay — 20 legs)
BASE_MULT = {
    218660: 0.5,
    239276: 0.7,
    239282: 0.7,
    239292: 0.5,
    241565: 1.0,
    241567: 1.0,
    242965: 1.0,
    242966: 1.0,
    242968: 0.7,
    242969: 0.5,
    242970: 0.7,
    242972: 0.35,
    242973: 1.0,
    242974: 0.5,
    242976: 0.5,
    242977: 0.7,
    253635: 0.5,  # CRV 4h CT — swapped to TV in v4.3
    253636: 1.0,
    253637: 1.0,
    253638: 1.0,
}
CRV_4H = 253635
TV_BURST_IDS = [253636, 253637, 253638]  # SUI, DOGE, SOL (+ CRV after swap)
CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}


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
    return requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=120).json()


def ensure_crv_tv(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name='BTDD_D1' AND s.name='TV_BURST_15M_CRVUSDT'""",
    ).fetchone()
    if row:
        return int(row[0])
    ak = conn.execute("SELECT id FROM api_keys WHERE name='BTDD_D1'").fetchone()
    conn.execute(
        """INSERT INTO strategies (
            name, api_key_id, strategy_type, market_mode, base_symbol, quote_symbol, interval,
            price_channel_length, zscore_entry, zscore_exit, zscore_stop, take_profit_percent,
            long_enabled, short_enabled, lot_long_percent, lot_short_percent, is_active,
            display_on_chart, show_settings, show_chart, show_indicators, show_positions_on_chart,
            auto_update, reinvest_percent, leverage, margin_type, detection_source, state
        ) VALUES ('TV_BURST_15M_CRVUSDT', ?, 'momentum_scalp_tv', 'mono', 'CRVUSDT', '', '15m',
            8, 21, 20, 1.2, 2.0, 1, 1, 100, 100, 0, 0, 1, 0, 0, 0, 1, 100, 20, 'cross', 'close', 'flat')""",
        (int(ak[0]),),
    )
    conn.commit()
    return int(conn.execute("SELECT id FROM strategies WHERE name='TV_BURST_15M_CRVUSDT'").fetchone()[0])


def load_strategy_meta(conn: sqlite3.Connection, sid: int) -> dict | None:
    row = conn.execute(
        "SELECT id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval FROM strategies WHERE id=?",
        (sid,),
    ).fetchone()
    if not row:
        return None
    market = f"{row[4]}/{row[5]}" if row[5] else row[4]
    tier = "burst_15m_tv" if row[2] == "momentum_scalp_tv" else (
        "mono_4h_ct" if row[6] == "4h" and str(row[3]).lower() == "mono" else
        "1d_dd_trend" if row[2] == "DD_BattleToads" else "4h_ct" if row[6] == "4h" else "1d_ct"
    )
    return {
        "strategyId": int(row[0]),
        "strategyName": row[1],
        "strategyType": row[2],
        "marketMode": "mono" if str(row[3]).lower() == "mono" else "synthetic",
        "market": market,
        "interval": row[6],
        "tier": tier,
        "legLotMult": BURST_MULT if row[2] == "momentum_scalp_tv" else BASE_MULT.get(sid, 1.0),
        "effectiveMult": BURST_MULT if row[2] == "momentum_scalp_tv" else BASE_MULT.get(sid, 1.0),
    }


def build_members(conn: sqlite3.Connection, crv_tv: int) -> list[dict]:
    sids = [crv_tv if x == CRV_4H else x for x in BASE_MULT.keys()]
    tv_ids = {crv_tv, *TV_BURST_IDS}
    members: list[dict] = []
    for sid in sids:
        m = load_strategy_meta(conn, sid)
        if not m:
            print(f"warn: missing strategy {sid}", file=sys.stderr)
            continue
        if sid in tv_ids:
            m["tier"] = "burst_15m_tv"
            m["legLotMult"] = BURST_MULT
            m["effectiveMult"] = BURST_MULT
        members.append(m)
    return members


def portfolio_preview(members: list[dict]) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    mul = {str(m["strategyId"]): float(m["effectiveMult"]) for m in members}
    max_dep = INITIAL * (1 + (REINVEST / 100) * 19)
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": OP,
        "lotPercentOverride": LOT,
        "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": max_dep,
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": CB,
    }
    return api_post("/api/backtest/run", payload).get("result") or {}


def offer_id(m: dict) -> str:
    mode = "mono" if m.get("marketMode") == "mono" else "synth"
    return f"offer_{mode}_{m.get('strategyType', '').lower()}_{m['strategyId']}"


def publish(members: list[dict], snapshot: dict) -> str:
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = [offer_id(m) for m in members]
    draft = [{
        "strategyId": int(m["strategyId"]),
        "strategyName": m["strategyName"],
        "strategyType": m["strategyType"],
        "marketMode": m["marketMode"],
        "market": m["market"],
        "score": snapshot.get("ret", 0),
        "weight": round(1.0 / len(members), 4),
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
    publish_flag = os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes")
    conn = sqlite3.connect(DB)
    crv_tv = ensure_crv_tv(conn)
    members = build_members(conn, crv_tv)
    preview = portfolio_preview(members)
    s = preview.get("summary") or {}
    mul = {str(m["strategyId"]): float(m["effectiveMult"]) for m in members}
    snapshot = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
        "periodDays": 763,
        "backtestSettings": {
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": INITIAL,
            "riskScore": RISK_SCORE,
            "tradeFrequencyScore": TRADE_FREQ,
            "lotPercentOverride": LOT,
            "maxOpenPositions": OP,
            "reinvestPercent": REINVEST,
            "maxDepositOverride": INITIAL * (1 + (REINVEST / 100) * 19),
            "lotPercentMultiplierByStrategyId": mul,
            "enablePairLock": True,
            "portfolioCircuitBreaker": CB,
            "backtestBars": 900,
            "warmupBars": 120,
        },
    }
    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "cardVersion": "v4.3",
        "parentCard": "synth-stable-union-v4-2-jul2026-zbhya",
        "burstUpgrade": {"crvTvSwap": True, "burstMult": BURST_MULT, "tvLegs": ["SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT"]},
        "members": members,
        "preview": snapshot,
    }
    json.dump(card, open(CARD_OUT, "w", encoding="utf-8"), indent=2)
    print(f"v4.3: {len(members)} legs burst_mult={BURST_MULT}")
    print(f"  ret={snapshot['ret']}% dd={snapshot['dd']}% trades={snapshot['trades']} pf={snapshot['pf']}")
    print(f"wrote {CARD_OUT}")
    if publish_flag:
        name = publish(members, snapshot)
        print(f"PUBLISHED → {name}")


if __name__ == "__main__":
    main()

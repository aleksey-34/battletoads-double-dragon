#!/usr/bin/env python3
"""
TV Momentum Cloud SPREAD card — many mono legs, modest lot, high OP.

  PUBLISH=1 python3 scripts/hybrid/build_tv_cloud_spread_card_jul2026.py
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
RANK_PATH = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_cloud_spread_rank_jul2026.json")
CARD_OUT = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_cloud_spread_card_jul2026.json")

API_KEY = "BTDD_D1"
SET_KEY = os.environ.get("CLOUD_SET_KEY", "tv-momentum-cloud-spread-jul2026")
DISPLAY_LABEL = os.environ.get("CLOUD_DISPLAY", "TV Momentum Cloud Spread 20 · Jul2026")
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL = float(os.environ.get("CLOUD_INITIAL", "10000"))


def api_get(path: str) -> dict:
    return requests.get(f"{API}{path}", headers=HEADERS, timeout=120).json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
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
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name=? AND s.name=?""",
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
    return int(conn.execute("SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, int(ak[0]))).fetchone()[0])


def portfolio_preview(members: list[dict], lot: float, op: int, reinvest: float) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0
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
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL * growth if growth else 0,
        "enablePairLock": True,
        "skipMissingSymbols": True,
    }
    return api_post("/api/backtest/run", payload).get("result") or {}


def offer_id(m: dict) -> str:
    return f"tv-cloud-{int(m['strategyId'])}"


def publish(members: list[dict], snapshot: dict) -> str:
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
    store = api_get("/api/saas/admin/offer-store")
    published = list(store.get("algofundPublishedSystemNames") or [])
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    return system_name


def main() -> None:
    if not os.path.isfile(RANK_PATH):
        print(f"run rank first: {RANK_PATH}", file=sys.stderr)
        sys.exit(1)
    rank = json.load(open(RANK_PATH, encoding="utf-8"))
    rec = rank.get("recommended") or {}
    symbols = rec.get("symbols") or rank.get("pickedSymbols") or []
    lot = float(os.environ.get("CLOUD_LOT", rec.get("lot") or 15))
    op = int(os.environ.get("CLOUD_OP", rec.get("maxOpenPositions") or 12))
    reinvest = float(os.environ.get("CLOUD_REINVEST", "75"))

    conn = sqlite3.connect(DB)
    members = []
    for sym in symbols:
        sid = ensure_tv(conn, sym)
        members.append({
            "strategyId": sid,
            "strategyName": f"TV_BURST_15M_{sym}",
            "strategyType": "momentum_scalp_tv",
            "marketMode": "mono",
            "market": sym,
            "interval": "15m",
            "tier": "burst_15m_tv",
            "legLotMult": 1.0,
            "effectiveMult": 1.0,
        })

    preview = portfolio_preview(members, lot, op, reinvest)
    s = preview.get("summary") or {}
    snapshot = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
        "backtestSettings": {
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": INITIAL,
            "lotPercentOverride": lot,
            "maxOpenPositions": op,
            "reinvestPercent": reinvest,
            "maxDepositOverride": INITIAL * min(20.0, 1.0 + (reinvest / 100.0) * 19.0),
            "enablePairLock": True,
            "backtestBars": 900,
            "warmupBars": 120,
        },
    }
    card = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "members": members,
        "rankSource": RANK_PATH,
        "localSimRecommended": rec,
        "preview": snapshot,
    }
    json.dump(card, open(CARD_OUT, "w", encoding="utf-8"), indent=2)
    print(f"TV cloud spread: {len(members)} legs lot={lot}% OP={op} ri={reinvest}%")
    print(f"  engine ret={snapshot['ret']}% dd={snapshot['dd']}% trades={snapshot['trades']}")
    print(f"wrote {CARD_OUT}")

    if os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes"):
        name = publish(members, snapshot)
        print(f"PUBLISHED → {name}")


if __name__ == "__main__":
    main()

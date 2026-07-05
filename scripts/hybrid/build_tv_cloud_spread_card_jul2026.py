#!/usr/bin/env python3
"""
TV Momentum Cloud SPREAD card — 20 mono TV legs, modest lot, high OP.

  PUBLISH=1 python3 scripts/hybrid/build_tv_cloud_spread_card_jul2026.py
  PUBLISH=1 FIX_MEMBERS=1 — replace members on existing published TS (same setKey)
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
DISPLAY_LABEL = os.environ.get("CLOUD_DISPLAY", "TV Momentum Cloud Spread 15m")
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL = float(os.environ.get("CLOUD_INITIAL", "10000"))
TV_PRESET = {
    "priceChannelLength": 8,
    "zscoreEntry": 21,
    "zscoreExit": 20,
    "zscoreStop": 1.2,
    "takeProfitPercent": 2.0,
    "detectionSource": "close",
}


def api_get(path: str) -> dict:
    return requests.get(f"{API}{path}", headers=HEADERS, timeout=120).json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    import time
    for attempt in range(30):
        r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
        data = r.json()
        err = str(data.get("error") or "")
        if data.get("success") is not False and not err:
            return data
        if "already running" in err.lower() and attempt < 29:
            time.sleep(10 + attempt * 2)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("backtest lock timeout")


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


CB_DEFAULT = {
    "enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8,
    "lotMultiplier": 0.5, "pauseDays": 14,
}


def portfolio_cb() -> dict | None:
    raw = os.environ.get("CLOUD_CB", "1").strip().lower()
    if raw in ("0", "false", "no", "off"):
        return None
    return CB_DEFAULT


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
    cb = portfolio_cb()
    if cb:
        payload["portfolioCircuitBreaker"] = cb
    return api_post("/api/backtest/run", payload).get("result") or {}


def offer_id(m: dict) -> str:
    return f"offer_mono_momentum_scalp_tv_{int(m['strategyId'])}"


def build_catalog_offer(m: dict, metrics: dict) -> dict:
    sid = int(m["strategyId"])
    market = str(m.get("market") or "")
    iv = str(m.get("interval") or "15m")
    oid = offer_id(m)
    name = str(m.get("strategyName") or f"Strategy {sid}")
    preset = {
        "strategyId": sid,
        "strategyName": name,
        "metrics": metrics,
        "params": {"interval": iv, **TV_PRESET},
    }
    return {
        "offerId": oid,
        "titleRu": f"TV Cloud • {market} • {iv}",
        "descriptionRu": "TV EMA+ADX momentum scalp mono 15m (cloud spread card).",
        "strategyId": sid,
        "strategyType": "momentum_scalp_tv",
        "mode": "mono",
        "market": market,
        "interval": iv,
        "strategy": {"id": sid, "name": name, "type": "momentum_scalp_tv", "mode": "mono", "market": market, "params": {"interval": iv}},
        "metrics": {**metrics, "score": metrics.get("ret", 0)},
        "sliderPresets": {"risk": {"high": preset}, "tradeFrequency": {"high": preset}},
        "presetMatrix": {"high": {"high": preset}},
    }


def sync_offers_to_store(members: list[dict], snapshot: dict) -> list[str]:
    """Return canonical offerIds for snapshot; catalog offers come from sweep, not patch."""
    return [offer_id(m) for m in members]


def build_snapshot(
    preview: dict,
    lot: float,
    op: int,
    reinvest: float,
    members: list[dict],
    offer_ids: list[str],
    system_name: str = "",
) -> dict:
    s = preview.get("summary") or {}
    try:
        d1 = datetime.strptime(DATE_FROM[:10], "%Y-%m-%d").date()
        d2 = datetime.strptime(DATE_TO[:10], "%Y-%m-%d").date()
        period_days = max(1, (d2 - d1).days)
    except ValueError:
        period_days = 760
    trades = int(s.get("tradesCount") or 0)
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0
    bs = {
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": INITIAL,
            "lotPercentOverride": lot,
            "maxOpenPositions": op,
            "reinvestPercent": reinvest,
            "maxDepositOverride": INITIAL * growth if growth else 0,
            "enablePairLock": True,
            "backtestBars": 900,
            "warmupBars": 120,
        }
    cb = portfolio_cb()
    if cb:
        bs["portfolioCircuitBreaker"] = cb
    return {
        "kind": "algofund-ts",
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "apiKeyName": API_KEY,
        "systemName": system_name,
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": trades,
        "tradesPerDay": round(trades / period_days, 2),
        "periodDays": period_days,
        "membersCount": len(members),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
        "backtestSettings": bs,
    }


def resolve_existing_system_name() -> str:
    store = api_get("/api/saas/admin/offer-store")
    snap = (store.get("tsBacktestSnapshots") or {}).get(SET_KEY) or {}
    name = str(snap.get("systemName") or "").strip()
    if name:
        return name
    for item in store.get("algofundPublishedSystemNames") or []:
        if SET_KEY.replace("-", "") in str(item).replace("-", ""):
            return str(item)
    return ""


def replace_system_members(system_name: str, members: list[dict]) -> None:
    if not os.path.isfile(DB):
        raise RuntimeError(f"DB not found: {DB}")
    conn = sqlite3.connect(DB)
    row = conn.execute("SELECT id FROM trading_systems WHERE name=?", (system_name,)).fetchone()
    if not row:
        raise RuntimeError(f"trading system not found: {system_name}")
    system_id = int(row[0])
    conn.execute("DELETE FROM trading_system_members WHERE system_id=?", (system_id,))
    w = round(1.0 / max(1, len(members)), 4)
    for i, m in enumerate(members):
        conn.execute(
            """INSERT INTO trading_system_members
               (system_id, strategy_id, weight, member_role, is_enabled, notes)
               VALUES (?, ?, ?, ?, 1, ?)""",
            (system_id, int(m["strategyId"]), w, "core" if i < 3 else "satellite", f"tv_cloud {m.get('market', '')}"),
        )
    conn.execute(
        "UPDATE trading_systems SET max_members=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
        (max(len(members), 20), system_id),
    )
    conn.commit()
    conn.close()
    print(f"replaced members on {system_name}: {len(members)} TV legs")


def publish(members: list[dict], snapshot: dict, edit_in_place: bool) -> str:
    store = api_get("/api/saas/admin/offer-store")
    offer_ids = sync_offers_to_store(members, snapshot)
    snapshot = build_snapshot(
        {"summary": {
            "totalReturnPercent": snapshot["ret"],
            "maxDrawdownPercent": snapshot["dd"],
            "profitFactor": snapshot["pf"],
            "tradesCount": snapshot["trades"],
            "finalEquity": snapshot.get("finalEquity", INITIAL),
        }},
        snapshot["backtestSettings"]["lotPercentOverride"],
        snapshot["backtestSettings"]["maxOpenPositions"],
        snapshot["backtestSettings"]["reinvestPercent"],
        members,
        offer_ids,
        system_name=str(snapshot.get("systemName") or resolve_existing_system_name()),
    )
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

    existing = resolve_existing_system_name()
    if os.environ.get("FIX_MEMBERS", "").strip() in ("1", "true", "yes") and existing:
        replace_system_members(existing, members)
        snapshot["systemName"] = existing
        published = list(store.get("algofundPublishedSystemNames") or [])
        api_patch("/api/saas/admin/offer-store", {
            "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, existing: snapshot},
            "algofundPublishedSystemNames": list(dict.fromkeys([existing, *published])),
        })
        return existing

    pub = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": edit_in_place,
    }, timeout=300)
    system_name = str((pub.get("sourceSystem") or {}).get("systemName") or existing).strip()
    if not system_name:
        raise RuntimeError(f"publish failed: {pub}")
    snapshot["systemName"] = system_name
    published = list(store.get("algofundPublishedSystemNames") or [])
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    if edit_in_place and existing:
        replace_system_members(system_name, members)
    return system_name


def main() -> None:
    if not os.path.isfile(RANK_PATH):
        print(f"run rank first: {RANK_PATH}", file=sys.stderr)
        sys.exit(1)
    rank = json.load(open(RANK_PATH, encoding="utf-8"))
    rec = rank.get("recommended") or {}
    symbols = rec.get("symbols") or rank.get("pickedSymbols") or []
    lot = float(os.environ.get("CLOUD_LOT", rec.get("lot") or 18))
    op = int(os.environ.get("CLOUD_OP", rec.get("maxOpenPositions") or 16))
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
        "offerIds": [offer_id(m) for m in members],
        "members": members,
        "rankSource": RANK_PATH,
        "localSimRecommended": rec,
        "preview": snapshot,
    }
    os.makedirs(os.path.dirname(CARD_OUT), exist_ok=True)
    json.dump(card, open(CARD_OUT, "w", encoding="utf-8"), indent=2)
    print(f"TV cloud spread: {len(members)} legs lot={lot}% OP={op} ri={reinvest}%")
    print(f"  engine ret={snapshot['ret']}% dd={snapshot['dd']}% trades={snapshot['trades']}")
    print(f"wrote {CARD_OUT}")

    if os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes"):
        fix = os.environ.get("FIX_MEMBERS", "1").strip() in ("1", "true", "yes")
        name = publish(members, snapshot, edit_in_place=fix)
        print(f"PUBLISHED → {name} ({len(members)} legs, offerIds in snapshot)")


if __name__ == "__main__":
    main()

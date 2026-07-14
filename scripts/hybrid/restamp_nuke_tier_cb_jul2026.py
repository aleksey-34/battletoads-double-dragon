#!/usr/bin/env python3
"""Restamp Nuke (L32 he23gk) card + snapshots with honest tier-CB engine metrics."""
from __future__ import annotations

import json
import sqlite3
import time
from copy import deepcopy

import requests

API = "http://127.0.0.1:3001"
H = {"Authorization": "Bearer btdd_admin_sweep_2026", "Content-Type": "application/json"}
DB = "/opt/battletoads-double-dragon/backend/database.db"
SYSTEM_ID = 213
DATE_FROM = "2024-06-01"
DATE_TO = "2026-07-11"

TIER_CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
    "applyToStrategyTypes": ["zz_breakout"],
}


def run_tier_bt(sids: list[int]) -> dict:
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 9000,
        "warmupBars": 120,
        "initialBalance": 10000,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": 16,
        "lotPercentOverride": 32,
        "reinvestPercentOverride": 75,
        "maxDepositOverride": 10000 * min(20, 1 + (75 / 100) * 19),
        "lotPercentMultiplierByStrategyId": {str(i): 1.0 for i in sids},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": TIER_CB,
    }
    for _ in range(60):
        data = requests.post(f"{API}/api/backtest/run", headers=H, json=payload, timeout=2400).json()
        err = str(data.get("error") or "")
        if "already running" in err.lower():
            time.sleep(8)
            continue
        if data.get("success") is False or (err and not data.get("result")):
            raise RuntimeError(err or str(data)[:400])
        summary = (data.get("result") or {}).get("summary") or {}
        return {
            "ret": round(float(summary.get("totalReturnPercent") or 0), 2),
            "dd": round(float(summary.get("maxDrawdownPercent") or 0), 2),
            "pf": round(float(summary.get("profitFactor") or 0), 3),
            "trades": int(summary.get("tradesCount") or 0),
            "finalEquity": round(float(summary.get("finalEquity") or 0), 2),
            "cbTriggers": int(summary.get("portfolioCircuitBreakerTriggers") or 0),
        }
    raise RuntimeError("backtest lock timeout")


def main() -> None:
    conn = sqlite3.connect(DB)
    sids = [
        r[0]
        for r in conn.execute(
            """
            SELECT s.id FROM trading_system_members m
            JOIN strategies s ON s.id = m.strategy_id
            WHERE m.system_id = ? AND COALESCE(m.is_enabled, 1) = 1
            ORDER BY s.id
            """,
            (SYSTEM_ID,),
        )
    ]
    print("legs", len(sids), flush=True)
    metrics = run_tier_bt(sids)
    print("tier_metrics", metrics, flush=True)

    updated_cards = 0
    for code, meta_raw in conn.execute(
        "SELECT code, metadata_json FROM master_cards WHERE is_active=1 AND lower(code) LIKE '%he23gk%'"
    ):
        meta = json.loads(meta_raw or "{}")
        meta["portfolioCircuitBreaker"] = dict(TIER_CB)
        meta["ret"] = metrics["ret"]
        meta["dd"] = metrics["dd"]
        meta["pf"] = metrics["pf"]
        meta["trades"] = metrics["trades"]
        if isinstance(meta.get("backtestSettings"), dict):
            meta["backtestSettings"]["portfolioCircuitBreaker"] = dict(TIER_CB)
        conn.execute(
            "UPDATE master_cards SET metadata_json=?, updated_at=CURRENT_TIMESTAMP WHERE code=?",
            (json.dumps(meta, ensure_ascii=False), code),
        )
        updated_cards += 1
        print("card", code, "->", metrics, flush=True)
    conn.commit()

    store = requests.get(f"{API}/api/saas/admin/offer-store", headers=H, timeout=120).json()
    snaps = dict(store.get("tsBacktestSnapshots") or {})
    snap_patch: dict = {}
    for key, value in snaps.items():
        if not isinstance(value, dict):
            continue
        sys = str(value.get("systemName") or key).lower()
        if "he23gk" not in sys and "boost-l32" not in sys:
            continue
        nv = deepcopy(value)
        bs = nv.get("backtestSettings") if isinstance(nv.get("backtestSettings"), dict) else {}
        if not isinstance(bs, dict):
            bs = {}
        bs["portfolioCircuitBreaker"] = dict(TIER_CB)
        bs.setdefault("dateFrom", DATE_FROM)
        bs.setdefault("dateTo", DATE_TO)
        bs.setdefault("lotPercentOverride", 32)
        bs.setdefault("reinvestPercent", 75)
        bs.setdefault("maxOpenPositions", 16)
        nv["backtestSettings"] = bs
        nv["ret"] = metrics["ret"]
        nv["dd"] = metrics["dd"]
        nv["pf"] = metrics["pf"]
        nv["trades"] = metrics["trades"]
        nv["finalEquity"] = metrics["finalEquity"]
        snap_patch[key] = nv
        print("snap", key, "->", metrics, flush=True)

    if snap_patch:
        r = requests.patch(
            f"{API}/api/saas/admin/offer-store",
            headers=H,
            json={"tsBacktestSnapshotsPatch": snap_patch},
            timeout=120,
        )
        print("offer-store patch", r.status_code, str(r.text)[:200], flush=True)

    print(json.dumps({"updatedCards": updated_cards, "updatedSnaps": len(snap_patch), "metrics": metrics}, indent=2))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
RedFlag (TradingView hamster-bot) → TGen volume addon research.

Pine logic mapped to BTDD classic DCA:
  drop_percent=0.15 → stepPercent=0.15
  tp=0.15 → tpPercent=0.15
  count=6 → maxOrders=6
  each_tp=true → per-leg TP (dca_per_leg style in backtest when supported)

Runs standalone mono DCA backtests on high-turnover markets + optional addon to v3b TS portfolio.

  python3 scripts/admin_tools/storefront/research_tgen_redflag_jul2026.py
  python3 ... --with-v3b  # TS portfolio + DCA markets overlay estimate
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026")
if not AUTH.lower().startswith("bearer "):
    AUTH = f"Bearer {AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
REPO = os.environ.get("BTDD_REPO", "/opt/battletoads-double-dragon")
DB = os.path.join(REPO, "backend", "database.db")
DATE_FROM = os.environ.get("TGEN_DATE_FROM", "2024-06-01")
DATE_TO = datetime.now(timezone.utc).date().isoformat()

# RedFlag defaults
TGEN_STEP = float(os.environ.get("TGEN_STEP", "0.15"))
TGEN_TP = float(os.environ.get("TGEN_TP", "0.15"))
TGEN_MAX_ORDERS = int(os.environ.get("TGEN_MAX_ORDERS", "6"))
TGEN_INTERVAL = os.environ.get("TGEN_INTERVAL", "15m")
TGEN_BASE_PCT = float(os.environ.get("TGEN_BASE_PCT", "5.0"))

# High-volume mono candidates for churn / rebate layer
TGEN_MARKETS = [
    m.strip()
    for m in os.environ.get(
        "TGEN_MARKETS",
        "SUIUSDT,TRXUSDT,DOGEUSDT,PEPEUSDT,WIFUSDT,1000PEPEUSDT",
    ).split(",")
    if m.strip()
]


def api_post(path: str, payload: dict, timeout: int = 600) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def find_dca_strategy(conn: sqlite3.Connection, market: str) -> int | None:
    base = market.strip().upper()
    row = conn.execute(
        """
        SELECT s.id FROM strategies s
        JOIN api_keys ak ON ak.id = s.api_key_id
        WHERE ak.name = 'BTDD_D1'
          AND s.strategy_type = 'dca'
          AND s.base_symbol = ?
          AND s.is_archived = 0
        ORDER BY CASE WHEN s.interval = ? THEN 0 ELSE 1 END, s.id DESC
        LIMIT 1
        """,
        (base, TGEN_INTERVAL),
    ).fetchone()
    return int(row[0]) if row else None


def run_dca_backtest(strategy_id: int, market: str) -> dict:
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "single",
        "strategyId": strategy_id,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "initialBalance": 10000,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "dcaStepPercentOverride": TGEN_STEP,
        "dcaTpPercentOverride": TGEN_TP,
        "dcaMaxOrdersOverride": TGEN_MAX_ORDERS,
        "dcaBaseAmountPercentOverride": TGEN_BASE_PCT,
        "intervalOverride": TGEN_INTERVAL,
    }
    data = api_post("/api/backtest/run", payload, timeout=900)
    if not data.get("success"):
        return {"market": market, "strategyId": strategy_id, "error": data.get("error")}
    s = (data.get("result") or {}).get("summary") or {}
    return {
        "market": market,
        "strategyId": strategy_id,
        "interval": TGEN_INTERVAL,
        "step": TGEN_STEP,
        "tp": TGEN_TP,
        "maxOrders": TGEN_MAX_ORDERS,
        "ret": float(s.get("totalReturnPercent") or 0),
        "dd": float(s.get("maxDrawdownPercent") or 0),
        "trades": int(s.get("tradesCount") or 0),
        "pf": float(s.get("profitFactor") or 0),
        "winRate": float(s.get("winRatePercent") or 0),
    }


def load_v3b_strategy_ids() -> list[int]:
    snap_path = os.path.join(REPO, "results", "union_v3b_grid_progress.json")
    if not os.path.isfile(snap_path):
        return []
    with open(snap_path, encoding="utf-8") as f:
        doc = json.load(f)
    best = doc.get("best") or {}
    return list(best.get("strategyIds") or [])


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--with-v3b", action="store_true", help="Also run combined preview TS+TGen markets")
    args = parser.parse_args()

    conn = sqlite3.connect(DB)
    standalone: list[dict] = []
    for market in TGEN_MARKETS:
        sid = find_dca_strategy(conn, market)
        if not sid:
            print(f"  skip {market}: no DCA strategy in DB")
            continue
        print(f"TGen backtest {market} dca#{sid} step={TGEN_STEP}% tp={TGEN_TP}% ...")
        standalone.append(run_dca_backtest(sid, market))
    conn.close()

    standalone.sort(key=lambda r: (-float(r.get("trades") or 0), -float(r.get("ret") or 0)))
    print("\n=== TGen standalone (RedFlag-like DCA) ===")
    for r in standalone:
        if r.get("error"):
            print(f"  {r['market']}: ERR {r['error']}")
        else:
            print(
                f"  {r['market']:14} ret={r['ret']:6.1f}% dd={r['dd']:5.1f}% "
                f"trades={r['trades']:5} pf={r['pf']:.2f}"
            )

    out = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "pineMapping": {
            "name": "RedFlag → TGen",
            "drop_percent": TGEN_STEP,
            "tp": TGEN_TP,
            "count": TGEN_MAX_ORDERS,
            "each_tp": True,
            "note": "Classic DCA limit ladder; closest BTDD engine is strategy_type=dca",
        },
        "window": {"from": DATE_FROM, "to": DATE_TO},
        "standalone": standalone,
        "recommendation": None,
    }

    good = [r for r in standalone if not r.get("error") and float(r.get("ret") or 0) > -5 and int(r.get("trades") or 0) > 50]
    if good:
        top = good[0]
        out["recommendation"] = {
            "standaloneBest": top["market"],
            "reason": "highest trade count with acceptable ret for volume layer",
            "addonNote": "Add as separate mono DCA budget (3-5% equity) alongside v3b synth core; do not merge wallet without cap",
        }

    if args.with_v3b:
        v3b_ids = load_v3b_strategy_ids()
        if v3b_ids:
            payload = {
                "apiKeyName": "BTDD_D1",
                "mode": "portfolio",
                "strategyIds": v3b_ids[:20],
                "dateFrom": DATE_FROM,
                "dateTo": DATE_TO,
                "initialBalance": 10000,
                "commissionPercent": 0.1,
                "maxOpenPositions": 12,
                "lotPercentOverride": 20,
                "reinvestPercentOverride": 100,
                "skipMissingSymbols": True,
            }
            ts_only = api_post("/api/backtest/run", payload, timeout=900)
            ts_s = (ts_only.get("result") or {}).get("summary") or {}
            out["v3b_ts_only"] = {
                "ret": float(ts_s.get("totalReturnPercent") or 0),
                "dd": float(ts_s.get("maxDrawdownPercent") or 0),
                "trades": int(ts_s.get("tradesCount") or 0),
            }
            print(f"\nv3b TS-only baseline: ret={out['v3b_ts_only']['ret']:.1f}% dd={out['v3b_ts_only']['dd']:.1f}%")

    path = os.path.join(REPO, "results", "tgen_redflag_research_latest.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, indent=2)
    print(f"\nWrote {path}")


if __name__ == "__main__":
    main()

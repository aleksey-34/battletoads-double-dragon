#!/usr/bin/env python3
"""
TV Burst TURBO — sizing grid for personal mono momentum_scalp_tv card (DD target ~40%).

  python3 scripts/hybrid/research_tv_burst_turbo_jul2026.py
  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/research_tv_burst_turbo_jul2026.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from itertools import product

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
OUT_DIR = os.path.join(REPO, "results", "tv_burst_turbo")
OUT = os.path.join(OUT_DIR, "tv_burst_turbo_sizing_grid_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL = float(os.environ.get("TURBO_INITIAL", "10000"))
EP4 = ("2026-05-01", "2026-06-30")
EP3 = ("2025-07-24", "2025-10-11")

# Core from EP4 grid (dual-positive preset 8/21). CRV added — strong ep3+ep4 on 15m TV.
CORE_MARKETS = ["SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT"]
EXPAND_MARKETS = ["WIFUSDT", "PEPEUSDT", "BNBUSDT", "TRXUSDT"]

# Optional hedge legs (non-overlapping mono / synth, low mult)
HEDGE_CANDIDATES = [
    {"strategyId": 253223, "market": "TIAUSDT", "tier": "hedge_4h_ct", "mult": 0.25},
    {"strategyId": 218660, "market": "DOGEUSDT/SOLUSDT", "tier": "hedge_1d_dd", "mult": 0.2},
]


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    for attempt in range(12):
        r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
        data = r.json()
        if data.get("success") is not False and "error" not in data:
            return data
        err = str(data.get("error") or "")
        if "already running" in err.lower():
            time.sleep(5 + attempt * 2)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("backtest lock timeout")


def ensure_tv_strategy(conn: sqlite3.Connection, base: str) -> int:
    name = f"TV_BURST_15M_{base}"
    row = conn.execute(
        """SELECT s.id FROM strategies s
           JOIN api_keys ak ON ak.id = s.api_key_id
           WHERE ak.name = 'BTDD_D1' AND s.name = ?""",
        (name,),
    ).fetchone()
    if row:
        return int(row[0])
    ak = conn.execute("SELECT id FROM api_keys WHERE name='BTDD_D1'").fetchone()
    if not ak:
        raise SystemExit("BTDD_D1 api_key missing")
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
    row = conn.execute("SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, int(ak[0]))).fetchone()
    return int(row[0])


def norm_ms(v: int) -> int:
    v = int(v or 0)
    return v * 1000 if 0 < v < 1_000_000_000_000 else v


def window_summary(trades: list, t0: str, t1: str) -> dict:
    start = int(datetime.fromisoformat(t0).replace(tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime.fromisoformat(f"{t1}T23:59:59").replace(tzinfo=timezone.utc).timestamp() * 1000)
    net = 0.0
    n = 0
    for tr in trades:
        ex = norm_ms(tr.get("exitTime"))
        if ex < start or ex > end:
            continue
        net += float(tr.get("netPnl") or 0)
        n += 1
    return {"ret": round((net / INITIAL) * 100, 2) if INITIAL else 0, "trades": n}


def run_portfolio(
    sids: list[int],
    mul: dict[str, float],
    *,
    lot: float,
    op: int,
    reinvest: float,
    cb: dict | None,
) -> dict:
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0
    payload = {
        "apiKeyName": "BTDD_D1",
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
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
    }
    if cb:
        payload["portfolioCircuitBreaker"] = cb
    res = api_post("/api/backtest/run", payload).get("result") or {}
    s = res.get("summary") or {}
    trades = res.get("trades") or []
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "trades": int(s.get("tradesCount") or 0),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
        "ep4": window_summary(trades, EP4[0], EP4[1]),
        "ep3": window_summary(trades, EP3[0], EP3[1]),
    }


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    conn = sqlite3.connect(DB)

    core_ids = {m: ensure_tv_strategy(conn, m) for m in CORE_MARKETS}
    expand_ids = {m: ensure_tv_strategy(conn, m) for m in EXPAND_MARKETS}

    lots = [float(x) for x in os.environ.get("TURBO_LOTS", "30,35,40,45").split(",")]
    ops = [int(x) for x in os.environ.get("TURBO_OPS", "6,8,10").split(",")]
    reinvests = [float(x) for x in os.environ.get("TURBO_REINVEST", "50,75,100").split(",")]

    configs: list[dict] = []
    for lot, op, reinvest in product(lots, ops, reinvests):
        for label, markets in (
            ("core4", CORE_MARKETS),
            ("core4+expand", CORE_MARKETS + EXPAND_MARKETS),
        ):
            sids = [core_ids[m] if m in core_ids else expand_ids[m] for m in markets]
            mul = {str(s): 1.0 for s in sids}
            try:
                m = run_portfolio(sids, mul, lot=lot, op=op, reinvest=reinvest, cb=None)
            except Exception as exc:
                print(f"skip {label} lot={lot} op={op} ri={reinvest}: {exc}", file=sys.stderr)
                continue
            row = {
                "label": label,
                "markets": markets,
                "strategyIds": sids,
                "lotPercent": lot,
                "maxOpenPositions": op,
                "reinvestPercent": reinvest,
                "circuitBreaker": None,
                **m,
            }
            configs.append(row)
            print(
                f"{label:14} lot={lot:4.0f} op={op:2d} ri={reinvest:3.0f} "
                f"ret={m['ret']:8.1f}% dd={m['dd']:5.1f}% tr={m['trades']:5d} pf={m['pf']:.2f} ep4={m['ep4']['ret']:+.1f}%"
            )

    # Hedge overlay on best core4 configs near DD 35-45%
    near_target = [
        c for c in configs
        if c["label"] == "core4" and 30 <= c["dd"] <= 45 and c["ret"] > 0
    ]
    near_target.sort(key=lambda x: (-x["ret"], x["dd"]))
    hedge_runs: list[dict] = []
    for base in near_target[:3]:
        sids = list(base["strategyIds"])
        mul = {str(s): 1.0 for s in sids}
        for h in HEDGE_CANDIDATES:
            sid = int(h["strategyId"])
            if sid in sids:
                continue
            row_check = conn.execute("SELECT id FROM strategies WHERE id=?", (sid,)).fetchone()
            if not row_check:
                continue
            hsids = sids + [sid]
            hmul = dict(mul)
            hmul[str(sid)] = float(h["mult"])
            try:
                m = run_portfolio(
                    hsids,
                    hmul,
                    lot=base["lotPercent"],
                    op=base["maxOpenPositions"],
                    reinvest=base["reinvestPercent"],
                    cb=None,
                )
            except Exception as exc:
                print(f"hedge skip: {exc}", file=sys.stderr)
                continue
            hedge_runs.append({
                "base": {k: base[k] for k in ("lotPercent", "maxOpenPositions", "reinvestPercent", "ret", "dd", "trades")},
                "hedge": h,
                **m,
            })
            print(
                f"  +hedge {h['tier']:12} mult={h['mult']} "
                f"ret={m['ret']:8.1f}% dd={m['dd']:5.1f}% tr={m['trades']:5d}"
            )

    # Pick winner: max ret with DD <= 42, prefer high trades
    eligible = [c for c in configs if c["dd"] <= 42 and c["ret"] > 0]
    eligible.sort(key=lambda x: (-x["trades"], -x["ret"]))
    pick = eligible[0] if eligible else max(configs, key=lambda x: x["ret"])

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateRange": [DATE_FROM, DATE_TO],
        "coreMarkets": CORE_MARKETS,
        "coreStrategyIds": core_ids,
        "expandMarkets": EXPAND_MARKETS,
        "expandStrategyIds": expand_ids,
        "grid": configs,
        "hedgeOverlays": hedge_runs,
        "recommended": pick,
        "recommendedHedge": max(hedge_runs, key=lambda x: x["ret"]) if hedge_runs else None,
    }
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"\nrecommended: {pick['label']} lot={pick['lotPercent']} op={pick['maxOpenPositions']} "
          f"ri={pick['reinvestPercent']} ret={pick['ret']}% dd={pick['dd']}% trades={pick['trades']}")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

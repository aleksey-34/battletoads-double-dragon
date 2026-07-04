#!/usr/bin/env python3
"""
v4.2 zbhya overlay: swap CRV 4h CT → TV momentum 15m + burst weight sweep.

Does NOT touch live card. Results → results/v42_burst_weight_overlay_jul2026.json

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/research_v42_burst_weight_overlay_jul2026.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
OUT = os.path.join(REPO, "results", "v42_burst_weight_overlay_jul2026.json")

DATE_FROM = os.environ.get("DATE_FROM", "2024-06-01")
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
DATE_1Y_FROM = os.environ.get("DATE_1Y_FROM", "2025-07-04")

# Live zbhya snapshot multipliers (2026-07-04)
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
    253635: 0.5,  # CRV 4h CT — candidate for swap
    253636: 1.0,
    253637: 1.0,
    253638: 1.0,
}
TV_BURST = [253636, 253637, 253638]  # SUI, DOGE, SOL
CRV_4H = 253635
LOT = 22.0
OP = 15
REINVEST = 50.0
INITIAL = 10000.0
MAX_DEP = INITIAL * (1 + (REINVEST / 100) * 19)  # 50% reinvest cap
CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}

EP4 = ("2026-05-01", "2026-06-30")
EP3 = ("2025-07-24", "2025-10-11")


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    for attempt in range(15):
        r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
        data = r.json()
        if data.get("success") is not False and "error" not in data:
            return data
        err = str(data.get("error") or "")
        if "already running" in err.lower():
            time.sleep(6 + attempt)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("backtest lock timeout")


def ensure_crv_tv(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """SELECT s.id FROM strategies s
           JOIN api_keys ak ON ak.id = s.api_key_id
           WHERE ak.name = 'BTDD_D1' AND s.name = 'TV_BURST_15M_CRVUSDT'""",
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
        if start <= ex <= end:
            net += float(tr.get("netPnl") or 0)
            n += 1
    return {"ret": round((net / INITIAL) * 100, 2), "trades": n}


def run_bt(sids: list[int], mul: dict[int, float], date_from: str, date_to: str, cb: dict | None) -> dict:
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": date_from,
        "dateTo": date_to,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": OP,
        "lotPercentOverride": LOT,
        "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": MAX_DEP,
        "lotPercentMultiplierByStrategyId": {str(k): float(v) for k, v in mul.items()},
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
        "final": round(float(s.get("finalEquity") or INITIAL), 2),
        "ep4": window_summary(trades, EP4[0], EP4[1]),
        "ep3": window_summary(trades, EP3[0], EP3[1]),
    }


def build_scenario(
    label: str,
    *,
    swap_crv_tv: bool,
    burst_mult: float,
    crv_tv_id: int,
) -> tuple[list[int], dict[int, float]]:
    mul = dict(BASE_MULT)
    sids = list(mul.keys())
    if swap_crv_tv:
        sids = [crv_tv_id if x == CRV_4H else x for x in sids]
        del mul[CRV_4H]
        mul[crv_tv_id] = burst_mult
    tv_legs = TV_BURST + ([crv_tv_id] if swap_crv_tv else [])
    for sid in tv_legs:
        if sid in mul:
            mul[sid] = burst_mult
    return sids, mul


def main() -> None:
    conn = sqlite3.connect(DB)
    crv_tv = ensure_crv_tv(conn)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)

    scenarios: list[tuple[str, bool, float]] = [
        ("baseline_v42", False, 1.0),
        ("crv_tv_swap", True, 1.0),
        ("crv_tv_burst2x", True, 2.0),
        ("crv_tv_burst3x", True, 3.0),
        ("crv_tv_burst4x", True, 4.0),
        ("crv_tv_burst5x", True, 5.0),
        ("crv_tv_burst10x", True, 10.0),
        ("crv_tv_burst20x", True, 20.0),
    ]

    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "card": "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-2-jul2026-zbhya",
        "settings": {"lot": LOT, "op": OP, "reinvest": REINVEST, "cb": CB},
        "full": {},
        "last1y": {},
    }

    for label, swap, bmult in scenarios:
        sids, mul = build_scenario(label, swap_crv_tv=swap, burst_mult=bmult, crv_tv_id=crv_tv)
        print(f"=== {label} swap={swap} burst_mult={bmult} legs={len(sids)} ===", flush=True)
        full = run_bt(sids, mul, DATE_FROM, DATE_TO, CB)
        y1 = run_bt(sids, mul, DATE_1Y_FROM, DATE_TO, CB)
        row = {
            "swapCrvToTv": swap,
            "burstMult": bmult,
            "tvLegs": TV_BURST + ([crv_tv] if swap else []),
            "full": full,
            "last1y": y1,
        }
        report["full"][label] = row
        print(
            f"  full ret={full['ret']}% dd={full['dd']}% tr={full['trades']} ep4={full['ep4']['ret']}%",
            flush=True,
        )
        print(
            f"  1yr  ret={y1['ret']}% dd={y1['dd']}% tr={y1['trades']}",
            flush=True,
        )

    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

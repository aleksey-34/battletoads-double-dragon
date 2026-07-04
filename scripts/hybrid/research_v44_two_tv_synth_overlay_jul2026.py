#!/usr/bin/env python3
"""
v4.3 synth union → 2 cloud TV legs (instead of 4× burst), weight + OP sweep for v4.4.

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/research_v44_two_tv_synth_overlay_jul2026.py
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
OUT = os.path.join(REPO, "results", "v44_two_tv_synth_overlay_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
LOT = 22.0
REINVEST = 50.0
INITIAL = 10000.0
MAX_DEP = INITIAL * (1 + (REINVEST / 100) * 19)
CB = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}

# 16 synth + old CRV 4h slot — TV legs added separately
SYNTH_MULT = {
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
}

# Cloud sanity top + v4.3 baseline pairs for comparison
TV_PAIR_CANDIDATES = [
    ("DYDXUSDT", "EIGENUSDT"),
    ("DYDXUSDT", "APTUSDT"),
    ("WIFUSDT", "DYDXUSDT"),
    ("DYDXUSDT", "ENAUSDT"),
]

BURST_MULTS = [3.0, 4.0, 5.0, 6.0, 8.0]
OPS = [12, 15, 18, 20]


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    for attempt in range(15):
        r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
        data = r.json()
        if data.get("success") is not False and "error" not in data:
            return data
        err = str(data.get("error") or "")
        if "already running" in err.lower():
            time.sleep(8 + attempt)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("backtest lock timeout")


def ensure_tv(conn: sqlite3.Connection, base: str) -> int:
    name = f"TV_BURST_15M_{base}"
    row = conn.execute(
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name='BTDD_D1' AND s.name=?""",
        (name,),
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
        ) VALUES (?, ?, 'momentum_scalp_tv', 'mono', ?, '', '15m',
            8, 21, 20, 1.2, 2.0, 1, 1, 100, 100, 0, 0, 1, 0, 0, 0, 1, 100, 20, 'cross', 'close', 'flat')""",
        (name, int(ak[0]), base),
    )
    conn.commit()
    return int(conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()[0])


def run_bt(sids: list[int], mul: dict[int, float], op: int) -> dict:
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
        "lotPercentOverride": LOT,
        "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": MAX_DEP,
        "lotPercentMultiplierByStrategyId": {str(k): float(v) for k, v in mul.items()},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": CB,
    }
    res = api_post("/api/backtest/run", payload).get("result") or {}
    s = res.get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "trades": int(s.get("tradesCount") or 0),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "legs": len(sids),
    }


def build_v43_baseline(conn: sqlite3.Connection) -> tuple[list[int], dict[int, float]]:
    """v4.3 as published: 16 synth + CRV/SUI/DOGE/SOL TV burst 3×."""
    crv = ensure_tv(conn, "CRVUSDT")
    sui = ensure_tv(conn, "SUIUSDT")
    doge = ensure_tv(conn, "DOGEUSDT")
    sol = ensure_tv(conn, "SOLUSDT")
    old_tv = {253635: crv, 253636: sui, 253637: doge, 253638: sol}
    base = dict(SYNTH_MULT)
    base.update({253635: 0.5, 253636: 1.0, 253637: 1.0, 253638: 1.0})
    sids = [old_tv.get(k, k) for k in base]
    mul = {}
    for k, v in base.items():
        sid = old_tv.get(k, k)
        if k in (253635, 253636, 253637, 253638) or sid in (crv, sui, doge, sol):
            mul[sid] = 3.0
        else:
            mul[sid] = v
    return sids, mul


def build_two_tv(conn: sqlite3.Connection, pair: tuple[str, str], burst: float) -> tuple[list[int], dict[int, float]]:
    tv_ids = [ensure_tv(conn, sym) for sym in pair]
    sids = list(SYNTH_MULT.keys()) + tv_ids
    mul = {sid: float(m) for sid, m in SYNTH_MULT.items()}
    for tid in tv_ids:
        mul[tid] = burst
    return sids, mul


def main() -> None:
    conn = sqlite3.connect(DB)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    report: dict = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "settings": {"lot": LOT, "reinvest": REINVEST, "cb": CB},
        "baseline_v43": {},
        "grid": [],
        "best": {},
    }

    print("=== baseline v4.3 (4 TV burst 3×) ===", flush=True)
    sids, mul = build_v43_baseline(conn)
    base = run_bt(sids, mul, op=15)
    report["baseline_v43"] = {"pair": ["SUI", "DOGE", "SOL", "CRV"], "burst": 3.0, "op": 15, **base}
    print(f"  ret={base['ret']}% dd={base['dd']}% tr={base['trades']} legs={base['legs']}", flush=True)

    rows: list[dict] = []
    for pair in TV_PAIR_CANDIDATES:
        for burst, op in product(BURST_MULTS, OPS):
            sids, mul = build_two_tv(conn, pair, burst)
            label = f"{pair[0]}+{pair[1]}_b{burst:g}_op{op}"
            print(f"=== {label} ===", flush=True)
            try:
                row = run_bt(sids, mul, op)
            except Exception as exc:
                print(f"  skip: {exc}", file=sys.stderr)
                continue
            entry = {
                "label": label,
                "tvPair": list(pair),
                "burstMult": burst,
                "op": op,
                **row,
            }
            rows.append(entry)
            print(f"  ret={row['ret']}% dd={row['dd']}% tr={row['trades']}", flush=True)

    rows.sort(key=lambda x: (-x["ret"], x["dd"]))
    report["grid"] = rows

    # Best with DD <= 15%, else <= 18%
    pool = [r for r in rows if r["dd"] <= 15]
    if not pool:
        pool = [r for r in rows if r["dd"] <= 18]
    if not pool:
        pool = rows
    best = pool[0] if pool else {}
    report["best"] = best
    report["top10"] = rows[:10]

    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"\n=== TOP for v4.4 ===", flush=True)
    for r in rows[:8]:
        print(
            f"  {r['tvPair']} burst={r['burstMult']} op={r['op']} "
            f"ret={r['ret']}% dd={r['dd']}% tr={r['trades']}",
            flush=True,
        )
    if best:
        print(
            f"\nRECOMMENDED v4.4 draft: {best.get('tvPair')} burst={best.get('burstMult')} "
            f"op={best.get('op')} ret={best.get('ret')}% dd={best.get('dd')}%",
            flush=True,
        )
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

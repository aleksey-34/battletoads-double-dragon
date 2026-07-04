#!/usr/bin/env python3
"""
Razgon limit sweep: maxDeposit cap, reinvest, OP, CB — 4-leg TV turbo + v4.3 union burst3.

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/research_razgon_limits_jul2026.py
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
OUT = os.path.join(REPO, "results", "razgon_limits_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
INITIAL = 10000.0

TV4 = [253636, 253637, 253638]  # + CRV below
BASE_MULT = {
    218660: 0.5, 239276: 0.7, 239282: 0.7, 239292: 0.5,
    241565: 1.0, 241567: 1.0, 242965: 1.0, 242966: 1.0,
    242968: 0.7, 242969: 0.5, 242970: 0.7, 242972: 0.35,
    242973: 1.0, 242974: 0.5, 242976: 0.5, 242977: 0.7,
    253635: 0.5, 253636: 1.0, 253637: 1.0, 253638: 1.0,
}
CRV_4H = 253635
CB = {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    for attempt in range(12):
        r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
        data = r.json()
        if data.get("success") is not False and "error" not in data:
            return data
        err = str(data.get("error") or "")
        if "already running" in err.lower():
            time.sleep(5 + attempt)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("backtest lock timeout")


def crv_tv_id(conn: sqlite3.Connection) -> int:
    row = conn.execute(
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name='BTDD_D1' AND s.name='TV_BURST_15M_CRVUSDT'""",
    ).fetchone()
    if not row:
        raise SystemExit("CRV TV strategy missing")
    return int(row[0])


def union_v43_sids_mul(crv_tv: int, burst: float) -> tuple[list[int], dict[str, float]]:
    sids = [crv_tv if x == CRV_4H else x for x in BASE_MULT]
    mul = {str(crv_tv if k == CRV_4H else k): (burst if (k in TV4 or k == CRV_4H) else v) for k, v in BASE_MULT.items()}
    mul[str(crv_tv)] = burst
    return sids, mul


def run_bt(
    sids: list[int],
    mul: dict[str, float],
    *,
    lot: float,
    op: int,
    reinvest: float,
    max_dep: float | None,
    cb: dict | None,
) -> dict:
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
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
    }
    if max_dep is not None:
        payload["maxDepositOverride"] = max_dep
    if cb:
        payload["portfolioCircuitBreaker"] = cb
    res = api_post("/api/backtest/run", payload).get("result") or {}
    s = res.get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "trades": int(s.get("tradesCount") or 0),
        "final": round(float(s.get("finalEquity") or INITIAL), 2),
    }


def capped_max_dep(reinvest: float) -> float:
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0)
    return INITIAL * growth


def main() -> None:
    conn = sqlite3.connect(DB)
    crv = crv_tv_id(conn)
    tv4 = TV4 + [crv]
    tv4_mul = {str(s): 1.0 for s in tv4}

    scenarios: list[tuple[str, dict]] = []

    # v4.3 baseline (card settings)
    sids, mul = union_v43_sids_mul(crv, 3.0)
    scenarios.append(("v43_card_default", {
        "sids": "union20", "lot": 22, "op": 15, "reinvest": 50,
        "max_dep": capped_max_dep(50), "cb": CB, "mul": "burst3",
    }))

    # Same but uncapped compound (maxDeposit=0 → engine uses full equity)
    scenarios.append(("v43_no_maxdep_cap", {
        "sids": "union20", "lot": 22, "op": 15, "reinvest": 50, "max_dep": 0, "cb": CB,
    }))
    scenarios.append(("v43_reinv100_no_cap", {
        "sids": "union20", "lot": 22, "op": 15, "reinvest": 100, "max_dep": 0, "cb": CB,
    }))
    scenarios.append(("v43_reinv100_no_cap_no_cb", {
        "sids": "union20", "lot": 22, "op": 15, "reinvest": 100, "max_dep": 0, "cb": None,
    }))
    scenarios.append(("v43_burst5_reinv100", {
        "sids": "union20_burst5", "lot": 22, "op": 15, "reinvest": 100, "max_dep": 0, "cb": None,
    }))

    # Pure 4-leg turbo
    for lot in (45, 66, 100):
        scenarios.append((f"tv4_lot{lot}_ri100", {
            "sids": "tv4", "lot": lot, "op": 10, "reinvest": 100, "max_dep": 0, "cb": None,
        }))

    report: dict = {"generatedAt": datetime.now(timezone.utc).isoformat(), "rows": {}}

    for label, cfg in scenarios:
        if cfg["sids"] == "tv4":
            run_sids, run_mul = tv4, tv4_mul
        elif cfg["sids"] == "union20_burst5":
            run_sids, run_mul = union_v43_sids_mul(crv, 5.0)
        else:
            run_sids, run_mul = union_v43_sids_mul(crv, 3.0)
        print(f"=== {label} ===", flush=True)
        row = run_bt(
            run_sids, run_mul,
            lot=cfg["lot"], op=cfg["op"], reinvest=cfg["reinvest"],
            max_dep=cfg["max_dep"], cb=cfg.get("cb"),
        )
        row["config"] = cfg
        report["rows"][label] = row
        print(f"  ret={row['ret']}% dd={row['dd']}% final={row['final']}", flush=True)

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""Tune B3 (ATOM composition) to beat Turbo return — preview only, no publish."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
API_KEY = "BTDD_D1"
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL = 10000.0
OUT = "/opt/battletoads-double-dragon/results/b3_beat_turbo_tune_jul2026.json"
B3_SYSTEM_ID = 205
TURBO_SYSTEM_ID = 209
BARS = 9000

CB_MED = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}
CB_L400 = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 12,
    "lotMultiplier": 0.75,
    "pauseDays": 7,
}
CB_SOFT = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 15,
    "lotMultiplier": 0.7,
    "pauseDays": 5,
}
CB_OFF = {"enabled": False}


def api_post(path: str, payload: dict, timeout: int = 2400) -> dict:
    last: Exception | None = None
    for attempt in range(40):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last = exc
            time.sleep(8 + attempt)
            continue
        err = str(data.get("error") or "")
        if data.get("success") is False or (err and "result" not in data and path.endswith("/backtest/run")):
            if "already running" in err.lower() and attempt < 39:
                time.sleep(10 + attempt)
                continue
            if err and not data.get("result"):
                raise RuntimeError(err)
        return data
    raise RuntimeError(f"api_post failed: {last}")


def metrics_from(result: dict) -> dict:
    s = result.get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "wr": round(float(s.get("winRatePercent") or 0), 1),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
    }


def growth_cap(reinvest: float) -> float:
    return min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0.0


def run_portfolio(
    sids: list[int],
    lot: float,
    op: int,
    reinvest: float,
    cb: dict,
    mul: dict[str, float] | None = None,
) -> dict:
    growth = growth_cap(reinvest)
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": BARS,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL * growth if growth else 0,
        "lotPercentMultiplierByStrategyId": mul or {str(i): 1.0 for i in sids},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": cb,
    }
    data = api_post("/api/backtest/run", payload)
    return metrics_from(data.get("result") or {})


def member_rows(conn: sqlite3.Connection, system_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type, s.market_mode
           FROM trading_system_members m
           JOIN strategies s ON s.id = m.strategy_id
           WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1
           ORDER BY s.id""",
        (system_id,),
    ).fetchall()
    out = []
    for r in rows:
        name = str(r[1] or "")
        stype = str(r[5] or "")
        mode = str(r[6] or "")
        if "MOM" in name.upper() or "TV_MOM" in name.upper() or stype.lower() in ("momentum", "tv_momentum"):
            layer = "A"
        elif "DONCH" in name.upper() or stype.lower() in ("zz_breakout", "donchian"):
            layer = "B"
        elif "ZZ" in stype.upper() or "ZZFAST" in name.upper() or mode == "synthetic":
            layer = "C"
        else:
            layer = "X"
        out.append(
            {
                "id": int(r[0]),
                "name": name,
                "pair": f"{r[2]}/{r[3] or '-'}",
                "interval": r[4],
                "stype": stype,
                "mode": mode,
                "layer": layer,
            }
        )
    return out


def layer_weights(members: list[dict], a: float, b: float, c: float) -> dict[str, float]:
    wmap = {"A": a, "B": b, "C": c, "X": 1.0}
    return {str(m["id"]): float(wmap.get(m["layer"], 1.0)) for m in members}


def main() -> None:
    conn = sqlite3.connect(DB)
    b3 = member_rows(conn, B3_SYSTEM_ID)
    turbo = member_rows(conn, TURBO_SYSTEM_ID)
    b3_ids = [m["id"] for m in b3]
    turbo_ids = [m["id"] for m in turbo]
    print(f"DATE {DATE_FROM}→{DATE_TO} B3 legs={len(b3_ids)} Turbo legs={len(turbo_ids)}", flush=True)
    layers = {}
    for m in b3:
        layers.setdefault(m["layer"], []).append(m["pair"])
    print("B3 layers:", {k: len(v) for k, v in layers.items()}, flush=True)

    # baselines
    print("\n=== baselines (ATOM already on masters preferred) ===", flush=True)
    turbo_base = run_portfolio(turbo_ids, 22, 10, 75, CB_L400)
    print("TURBO lot22/OP10/ri75/CB_L400", turbo_base, flush=True)
    b3_base = run_portfolio(b3_ids, 15, 12, 50, CB_MED)
    print("B3   lot15/OP12/ri50/CB_MED", b3_base, flush=True)
    target_ret = turbo_base["ret"]

    grid: list[dict[str, Any]] = []
    # Compact high-signal grid (~45 BTs) — enough to hunt Turbo ret without overnight run
    candidates: list[tuple] = []
    sizing = [
        # turbo-like and hotter on leaner B3 book
        (22, 10, 75, "L400", CB_L400),
        (22, 12, 75, "L400", CB_L400),
        (22, 14, 75, "L400", CB_L400),
        (22, 16, 75, "L400", CB_L400),
        (25, 12, 75, "L400", CB_L400),
        (25, 14, 75, "L400", CB_L400),
        (25, 16, 75, "L400", CB_L400),
        (28, 12, 75, "L400", CB_L400),
        (28, 14, 75, "L400", CB_L400),
        (28, 16, 75, "L400", CB_L400),
        (32, 14, 75, "L400", CB_L400),
        (32, 16, 75, "L400", CB_L400),
        (35, 14, 75, "L400", CB_L400),
        (35, 16, 75, "L400", CB_L400),
        # softer / harder CB at strong size
        (25, 14, 75, "SOFT", CB_SOFT),
        (28, 14, 75, "SOFT", CB_SOFT),
        (32, 16, 75, "SOFT", CB_SOFT),
        (25, 14, 75, "MED", CB_MED),
        (28, 14, 75, "MED", CB_MED),
        (28, 14, 75, "OFF", CB_OFF),
        (32, 16, 75, "OFF", CB_OFF),
        # keep some ri50 control points
        (22, 14, 50, "L400", CB_L400),
        (28, 14, 50, "L400", CB_L400),
        (25, 12, 50, "MED", CB_MED),
    ]
    for lot, op, ri, cb_name, cb in sizing:
        candidates.append((lot, op, ri, cb_name, cb, "flat1", None))

    weight_presets = [
        ("boostC", 0.85, 0.85, 1.35),
        ("boostA", 1.35, 0.85, 0.85),
        ("boostB", 0.85, 1.35, 0.85),
        ("boostAC", 1.2, 0.7, 1.3),
        ("hotC", 0.7, 0.7, 1.6),
    ]
    for lot, op, ri, cb_name, cb in [
        (25, 14, 75, "L400", CB_L400),
        (28, 14, 75, "L400", CB_L400),
        (32, 16, 75, "SOFT", CB_SOFT),
    ]:
        for wname, a, b, c in weight_presets:
            candidates.append((lot, op, ri, cb_name, cb, wname, layer_weights(b3, a, b, c)))

    print(f"\n=== grid {len(candidates)} candidates, target Turbo ret={target_ret} ===", flush=True)
    best = None
    for i, (lot, op, ri, cb_name, cb, wname, mul) in enumerate(candidates, 1):
        t0 = time.time()
        try:
            m = run_portfolio(b3_ids, lot, op, ri, cb, mul)
        except Exception as e:
            print(f"[{i}/{len(candidates)}] FAIL lot={lot} op={op} ri={ri} cb={cb_name} w={wname}: {e}", flush=True)
            continue
        row = {
            "lot": lot,
            "op": op,
            "ri": ri,
            "cb": cb_name,
            "weights": wname,
            **m,
            "beatTurbo": m["ret"] > target_ret,
            "sec": round(time.time() - t0, 1),
        }
        grid.append(row)
        mark = "★" if row["beatTurbo"] else " "
        print(
            f"[{i}/{len(candidates)}]{mark} lot={lot} OP={op} ri={ri} cb={cb_name} w={wname} "
            f"ret={m['ret']} dd={m['dd']} pf={m['pf']} n={m['trades']} ({row['sec']}s)",
            flush=True,
        )
        if best is None or m["ret"] > best["ret"]:
            best = row

    grid_sorted = sorted(grid, key=lambda x: (-x["ret"], x["dd"]))
    winners = [g for g in grid_sorted if g["beatTurbo"]]
    out = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "turboBaseline": {"lot": 22, "op": 10, "ri": 75, "cb": "L400", **turbo_base},
        "b3Baseline": {"lot": 15, "op": 12, "ri": 50, "cb": "MED", **b3_base},
        "best": best,
        "winners": winners[:15],
        "top10": grid_sorted[:10],
        "all": grid_sorted,
        "b3Layers": {k: len(v) for k, v in layers.items()},
        "note": "preview only — not published",
    }
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT}", flush=True)
    print("\n=== TOP 10 B3 tunes ===", flush=True)
    for g in grid_sorted[:10]:
        print(
            f"  ret={g['ret']:8.2f} dd={g['dd']:6.2f} pf={g['pf']:.3f} "
            f"lot={g['lot']} OP={g['op']} ri={g['ri']} cb={g['cb']} w={g['weights']} "
            f"{'BEATS TURBO' if g['beatTurbo'] else ''}",
            flush=True,
        )
    if winners:
        print(f"\n{len(winners)} configs beat Turbo ret={target_ret}", flush=True)
    else:
        print(f"\nNo config beat Turbo ret={target_ret}. Best={best}", flush=True)


if __name__ == "__main__":
    main()

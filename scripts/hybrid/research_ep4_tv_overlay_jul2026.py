#!/usr/bin/env python3
"""
v4.1 + TV EMA+ADX burst overlay (honest sizing) → v4.2 draft metrics.

  python3 scripts/hybrid/research_ep4_tv_overlay_jul2026.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
OUT_DIR = os.path.join(REPO, "results", "ep4_burst_research")
BURST_JSON = os.path.join(OUT_DIR, "tv_burst_honest_overlay.json")
CARD_V41 = os.environ.get(
    "V41_CARD",
    os.path.join(REPO, "results", "synth_stable_union_card_v4.1_jul2026.json"),
)
OUT = os.path.join(OUT_DIR, "v4_2_tv_burst_overlay_jul2026.json")
CARD_OUT = os.path.join(REPO, "results", "synth_stable_union_card_v4.2_tv_burst_draft.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
BURST_SEED = float(os.environ.get("BURST_INITIAL", "2000"))
TOTAL_INITIAL = 10000.0

EP3 = ("2025-07-24", "2025-10-11")
EP4 = ("2026-05-01", "2026-06-30")

TV_BURST_PRESET = {
    "strategyType": "momentum_scalp_tv",
    "interval": "15m",
    "marketMode": "mono",
    "emaFastPeriod": 8,
    "emaSlowPeriod": 21,
    "adxPeriod": 14,
    "adxMin": 20,
    "tpPercent": 2.0,
    "slPercent": 1.2,
    "exitOnOppositeCross": True,
    "sideMode": "both",
    "maxOpenPositions": 3,
    "positionFraction": 0.75,
    "burstWalletUsdt": BURST_SEED,
    "markets": ["SUIUSDT", "DOGEUSDT", "SOLUSDT"],
    "legLotMult": 1.0,
    "tier": "burst_15m_tv",
}


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


def run_burst_node() -> dict:
    backend = os.path.join(REPO, "backend")
    subprocess.run(["npm", "run", "build"], cwd=backend, check=True, capture_output=True)
    env = {
        **os.environ,
        "OUT_DIR": OUT_DIR,
        "API_KEY": "BTDD_D1",
        "BURST_INITIAL": str(int(BURST_SEED)),
        "DATE_TO": DATE_TO,
    }
    subprocess.run(
        ["node", os.path.join(REPO, "scripts", "ep4_tv_burst_overlay.mjs")],
        cwd=backend,
        check=True,
        env=env,
    )
    return json.load(open(BURST_JSON))


def norm_ms(raw) -> int:
    v = int(raw or 0)
    if v <= 0:
        return 0
    return v * 1000 if v < 1_000_000_000_000 else v


def curve_to_map(curve: list, default_eq: float) -> dict[int, float]:
    out: dict[int, float] = {}
    for pt in curve or []:
        if isinstance(pt, dict):
            t = norm_ms(pt.get("timeMs") or pt.get("time") or pt.get("ts") or 0)
            e = float(pt.get("equity") or pt.get("value") or default_eq)
        else:
            continue
        if t > 0:
            out[t] = e
    return out


def forward_fill(times: list[int], m: dict[int, float], default: float) -> list[float]:
    if not times:
        return []
    sorted_keys = sorted(m.keys())
    vals: list[float] = []
    j = 0
    cur = default
    for t in times:
        while j < len(sorted_keys) and sorted_keys[j] <= t:
            cur = m[sorted_keys[j]]
            j += 1
        vals.append(cur)
    return vals


def metrics_from_equity(times: list[int], eq: list[float], initial: float) -> dict:
    if not eq:
        return {"ret": 0, "dd": 0, "finalEquity": initial}
    peak = eq[0]
    max_dd = 0.0
    for e in eq:
        peak = max(peak, e)
        if peak > 0:
            max_dd = max(max_dd, (peak - e) / peak * 100)
    final = eq[-1]
    return {
        "ret": round((final - initial) / initial * 100, 2) if initial else 0,
        "dd": round(max_dd, 2),
        "finalEquity": round(final, 2),
    }


def window_metrics(times: list[int], eq: list[float], t0: str, t1: str) -> dict:
    start = int(datetime.fromisoformat(t0).replace(tzinfo=timezone.utc).timestamp() * 1000)
    end = int(datetime.fromisoformat(f"{t1}T23:59:59").replace(tzinfo=timezone.utc).timestamp() * 1000)
    sub_t = [t for t in times if start <= t <= end]
    if len(sub_t) < 2:
        return {"ret": 0, "dd": 0}
    sub_eq = [eq[times.index(t)] for t in sub_t]
    base = sub_eq[0]
    peak = base
    max_dd = 0.0
    for e in sub_eq:
        peak = max(peak, e)
        if peak > 0:
            max_dd = max(max_dd, (peak - e) / peak * 100)
    ret = (sub_eq[-1] - base) / base * 100 if base else 0
    return {"ret": round(ret, 2), "dd": round(max_dd, 2)}


def run_v41_portfolio(card_path: str) -> dict:
    card = json.load(open(card_path))
    members = card.get("members") or []
    mul = {str(m["strategyId"]): float(m.get("effectiveMult") or m.get("legLotMult") or 1.0) for m in members}
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": [int(m["strategyId"]) for m in members],
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": TOTAL_INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": 12,
        "lotPercentOverride": 20,
        "reinvestPercentOverride": 50,
        "maxDepositOverride": 20000,
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": {
            "enabled": True,
            "peakWindowDays": 30,
            "ddTriggerPercent": 8,
            "lotMultiplier": 0.5,
            "pauseDays": 14,
        },
    }
    res = api_post("/api/backtest/run", payload).get("result") or {}
    s = res.get("summary") or {}
    return {
        "summary": {
            "ret": round(float(s.get("totalReturnPercent") or 0), 2),
            "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
            "trades": int(s.get("tradesCount") or 0),
            "pf": round(float(s.get("profitFactor") or 0), 3),
        },
        "equityCurve": res.get("equityCurve") or [],
    }


def merge_overlay(v41: dict, burst: dict) -> dict:
    v4_map = curve_to_map(v41["equityCurve"], TOTAL_INITIAL)
    burst_map = curve_to_map(burst.get("equityCurve") or [], BURST_SEED)
    times = sorted(set(v4_map.keys()) | set(burst_map.keys()))
    v4_eq = forward_fill(times, v4_map, TOTAL_INITIAL)
    burst_eq = forward_fill(times, burst_map, BURST_SEED)
    combined = [v + b - BURST_SEED for v, b in zip(v4_eq, burst_eq)]
    full = metrics_from_equity(times, combined, TOTAL_INITIAL)
    return {
        "combined": full,
        "ep4": window_metrics(times, combined, EP4[0], EP4[1]),
        "ep3": window_metrics(times, combined, EP3[0], EP3[1]),
        "deltaVsV41": {
            "retFull": round(full["ret"] - v41["summary"]["ret"], 2),
            "ddFull": round(full["dd"] - v41["summary"]["dd"], 2),
        },
        "equityCurveSample": [{"timeMs": t, "equity": round(e, 2)} for t, e in zip(times[:: max(1, len(times) // 200)], combined[:: max(1, len(combined) // 200)])],
    }


def build_v42_draft(card_v41_path: str, overlay: dict, burst: dict) -> dict:
    card = json.load(open(card_v41_path))
    draft = dict(card)
    draft["cardVersion"] = "v4.2-tv-burst-draft"
    draft["displayLabel"] = "Synth Stable Union v4.2 draft (+ TV 15m burst)"
    draft["burstLayer"] = {
        "enabled": True,
        "preset": TV_BURST_PRESET,
        "honestBacktest": {
            "burstOnly": burst.get("summary"),
            "burstWindows": burst.get("windows"),
            "perMarket": burst.get("perMarket"),
        },
        "overlayVsV41": overlay,
        "note": "Research module momentum_scalp_tv — not yet in live engine; burst wallet parallel to v4.1 core",
    }
    members = list(draft.get("members") or [])
    for sym in TV_BURST_PRESET["markets"]:
        pm = next((x for x in burst.get("perMarket") or [] if x.get("key") == sym), {})
        members.append(
            {
                "strategyId": None,
                "strategyName": f"TV_BURST_15M_{sym}",
                "market": sym,
                "tier": "burst_15m_tv",
                "legLotMult": 1.0,
                "effectiveMult": 1.0,
                "researchOnly": True,
                "burstPreset": TV_BURST_PRESET,
                "perMarketPnl": pm.get("netPnl"),
                "perMarketTrades": pm.get("trades"),
            }
        )
    draft["members"] = members
    draft["portfolioCircuitBreaker"] = draft.get("portfolioCircuitBreaker") or {
        "enabled": True,
        "peakWindowDays": 30,
        "ddTriggerPercent": 8,
        "lotMultiplier": 0.5,
        "pauseDays": 14,
    }
    return draft


def main() -> None:
    os.makedirs(OUT_DIR, exist_ok=True)
    card_path = CARD_V41
    if not os.path.isfile(card_path):
        vps_card = "/opt/battletoads-double-dragon/results/synth_stable_union_card_v4.1_jul2026.json"
        if os.path.isfile(vps_card):
            card_path = vps_card
        else:
            sys.exit(f"Missing v4.1 card: {CARD_V41}")

    print("=== TV burst honest overlay (node) ===")
    burst = run_burst_node()

    print("=== v4.1 baseline portfolio ===")
    v41 = run_v41_portfolio(card_path)
    print(f"  v4.1 ret={v41['summary']['ret']}% dd={v41['summary']['dd']}%")

    print("=== merge v4.1 + burst ===")
    overlay = merge_overlay(v41, burst)
    print(f"  combined ret={overlay['combined']['ret']}% dd={overlay['combined']['dd']}%")
    print(f"  EP4 ret={overlay['ep4']['ret']}% dd={overlay['ep4']['dd']}%")
    print(f"  delta ret={overlay['deltaVsV41']['retFull']}pp dd={overlay['deltaVsV41']['ddFull']}pp")

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "v41Baseline": v41["summary"],
        "burstLayer": {
            "preset": TV_BURST_PRESET,
            "summary": burst.get("summary"),
            "windows": burst.get("windows"),
            "perMarket": burst.get("perMarket"),
        },
        "overlay": overlay,
        "verdict": (
            "promote_v4.2_draft"
            if overlay["ep4"]["ret"] > 0 and overlay["deltaVsV41"]["ddFull"] <= 1.5
            else "research_continue"
        ),
    }
    json.dump(report, open(OUT, "w"), indent=2)

    draft = build_v42_draft(card_path, overlay, burst)
    json.dump(draft, open(CARD_OUT, "w"), indent=2)
    print(f"\nDone → {OUT}")
    print(f"Draft card → {CARD_OUT}")
    print(f"verdict: {report['verdict']}")


if __name__ == "__main__":
    main()

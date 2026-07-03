#!/usr/bin/env python3
"""Grid: circuit-breaker thresholds + optional v4.1+DCA combined preview."""
from __future__ import annotations

import itertools
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
OUT = os.path.join(REPO, "results/v4_cb_dca_grid_jul2026.json")

# v4.1 combo from defense research
ADDONS = [
    {"strategyId": 253635, "market": "CRVUSDT", "legLotMult": 0.5, "tier": "mono_4h_ct"},
    {"strategyId": 218660, "market": "DOGEUSDT/SOLUSDT", "legLotMult": 0.5, "tier": "1d_dd_trend"},
]

DCA_PRESETS = {
    "v2dca_dense": {"interval": "1h", "stepPercent": 0.5, "tpPercent": 1.2, "entryFilter": "always"},
    "fast_15m": {"interval": "15m", "stepPercent": 0.5, "tpPercent": 0.8, "entryFilter": "always"},
    "slow_4h": {"interval": "4h", "stepPercent": 1.0, "tpPercent": 2.0, "entryFilter": "always"},
    "wide_1h": {"interval": "1h", "stepPercent": 1.5, "tpPercent": 2.5, "entryFilter": "always"},
}


def normalize_ms(raw: int | float) -> int:
    v = int(raw or 0)
    return v * 1000 if 0 < v < 1_000_000_000_000 else v


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
        raise RuntimeError(err[:300])
    raise RuntimeError("lock timeout")


def resolve_members(conn: sqlite3.Connection, path: str) -> list[dict]:
    card = json.load(open(path, encoding="utf-8"))
    members = list(card.get("members") or [])
    for m in members:
        name = str(m.get("strategyName") or "")
        if name:
            row = conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()
            if row:
                m["strategyId"] = int(row[0])
    for ad in ADDONS:
        sid = int(ad["strategyId"])
        row = conn.execute("SELECT id, name, strategy_type FROM strategies WHERE id=?", (sid,)).fetchone()
        if row:
            members.append({
                "strategyId": int(row[0]),
                "strategyName": row[1],
                "strategyType": row[2],
                "market": ad["market"],
                "marketMode": "mono" if "/" not in ad["market"] else "synthetic",
                "legLotMult": ad["legLotMult"],
                "effectiveMult": ad["legLotMult"],
                "tier": ad["tier"],
            })
    return members


def portfolio_run(members: list[dict], macro: dict | None = None) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    mul = {str(m["strategyId"]): float(m.get("effectiveMult") or m.get("legLotMult") or 1.0) for m in members}
    payload = {
        "apiKeyName": "BTDD_D1", "mode": "portfolio", "strategyIds": sids,
        "dateFrom": "2024-06-01", "dateTo": datetime.now(timezone.utc).date().isoformat(),
        "bars": 900, "warmupBars": 120, "initialBalance": 10000,
        "commissionPercent": 0.1, "slippagePercent": 0.05, "maxOpenPositions": 12,
        "lotPercentOverride": 20, "reinvestPercentOverride": 50, "maxDepositOverride": 20000,
        "lotPercentMultiplierByStrategyId": mul, "enablePairLock": True, "skipMissingSymbols": True,
    }
    if macro:
        payload["macroExitOverlay"] = macro
    return (api_post("/api/backtest/run", payload).get("result") or {})


def equity_series(curve: list) -> list[tuple[int, float]]:
    out = []
    for pt in curve or []:
        if isinstance(pt, dict):
            t = normalize_ms(pt.get("time") or pt.get("ts") or 0)
            e = float(pt.get("equity") or pt.get("value") or 0)
            if t > 0 and e > 0:
                out.append((t, e))
    out.sort(key=lambda x: x[0])
    return out


def downsample(series: list[tuple[int, float]], max_pts: int = 400) -> list[tuple[int, float]]:
    if len(series) <= max_pts:
        return series
    step = max(1, len(series) // max_pts)
    out = series[::step]
    if out[-1] != series[-1]:
        out.append(series[-1])
    return out


def simulate_cb(
    series: list[tuple[int, float]],
    *,
    peak_window_days: int,
    dd_trigger: float,
    lot_mult: float,
    pause_days: int,
) -> dict:
    if len(series) < 2:
        return {"ret": 0, "dd": 0, "triggers": 0}
    series = downsample(series)
    ms_day = 86400000
    window = peak_window_days * ms_day
    pause_ms = pause_days * ms_day
    scaled = [(series[0][0], series[0][1])]
    cooldown = 0
    triggers = 0
    t2026 = int(datetime(2026, 1, 1, tzinfo=timezone.utc).timestamp() * 1000)
    # rolling peak via monotonic deque on index window
    from collections import deque
    dq: deque[tuple[int, float]] = deque()

    for i in range(1, len(series)):
        t, raw_cur = series[i]
        raw_prev = series[i - 1][1]
        prev = scaled[-1][1]
        bar_ret = (raw_cur / raw_prev - 1) if raw_prev > 0 else 0
        while dq and dq[0][0] < t - window:
            dq.popleft()
        while dq and dq[-1][1] <= raw_cur:
            dq.pop()
        dq.append((t, raw_cur))
        peak = dq[0][1] if dq else raw_cur
        dd = (peak - prev) / peak * 100 if peak > 0 else 0
        mult = 1.0
        if t < cooldown:
            mult = lot_mult
        elif dd >= dd_trigger:
            cooldown = t + pause_ms
            triggers += 1
            mult = lot_mult
        scaled.append((t, prev * (1 + bar_ret * mult)))

    ret = (scaled[-1][1] / scaled[0][1] - 1) * 100 if scaled[0][1] > 0 else 0
    peak_e = scaled[0][1]
    max_dd = 0.0
    ret_2026_start = next((e for ts, e in scaled if ts >= t2026), scaled[-1][1])
    ret_2026 = (scaled[-1][1] / ret_2026_start - 1) * 100 if ret_2026_start > 0 else 0
    for _, e in scaled:
        peak_e = max(peak_e, e)
        max_dd = max(max_dd, (peak_e - e) / peak_e * 100 if peak_e > 0 else 0)
    return {
        "ret": round(ret, 2),
        "dd": round(max_dd, 2),
        "ret2026": round(ret_2026, 2),
        "triggers": triggers,
        "peakWindowDays": peak_window_days,
        "ddTrigger": dd_trigger,
        "lotMult": lot_mult,
        "pauseDays": pause_days,
    }


def poll_combined(timeout: int = 1800) -> dict:
    deadline = time.time() + timeout
    while time.time() < deadline:
        st = requests.get(f"{API}/api/saas/admin/ts-dca-combined-preview-status", headers=HEADERS, timeout=60).json()
        if st.get("running"):
            time.sleep(5)
            continue
        if st.get("error"):
            raise RuntimeError(st["error"])
        if st.get("result"):
            return st["result"]
        time.sleep(2)
    raise RuntimeError("combined timeout")


def run_dca_combo(offer_ids: list[str], preset_name: str, preset: dict) -> dict:
    weights = {oid: round(1 / len(offer_ids), 6) for oid in offer_ids}
    tuning = {m: preset for m in ["SUIUSDT", "TRXUSDT"]}
    payload = {
        "setKey": "synth-stable-union-v4-jul2026",
        "apiKeyName": "BTDD_D1",
        "initialBalance": 10000,
        "lotPercentOverride": 20,
        "maxOpenPositions": 12,
        "reinvestPercent": 50,
        "riskScore": 4,
        "tradeFrequencyScore": 5,
        "enablePairLock": True,
        "offerIds": offer_ids,
        "offerWeightsById": weights,
        "markets": ["SUIUSDT", "TRXUSDT"],
        "marketTuning": tuning,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": 3.0,
        "dcaInterval": preset["interval"],
        "dcaStepPercent": preset["stepPercent"],
        "dcaTpPercent": preset["tpPercent"],
        "dcaMaxOrders": 20,
        "dcaAutotune": False,
        "dcaPerLegSl": False,
    }
    api_post("/api/saas/admin/ts-dca-combined-preview", payload, timeout=60)
    res = poll_combined()
    c = (res.get("combined") or {}).get("summary") or {}
    ts = (res.get("tsOnly") or {}).get("summary") or {}
    return {
        "preset": preset_name,
        "combined": {
            "ret": round(float(c.get("totalReturnPercent") or 0), 2),
            "dd": round(float(c.get("maxDrawdownPercent") or 0), 2),
            "pf": round(float(c.get("profitFactor") or 0), 3),
            "trades": int(c.get("tradesCount") or 0),
        },
        "tsOnly": {
            "ret": round(float(ts.get("totalReturnPercent") or 0), 2),
            "dd": round(float(ts.get("maxDrawdownPercent") or 0), 2),
        },
    }


def main() -> None:
    card_path = os.path.join(REPO, "results/synth_stable_union_card_v4_jul2026.json")
    if not os.path.isfile(card_path):
        card_path = "/opt/battletoads-double-dragon/results/synth_stable_union_card_v4_jul2026.json"
    conn = sqlite3.connect(DB)
    members = resolve_members(conn, card_path)

    print("=== v4.1 TS baseline ===", flush=True)
    result = portfolio_run(members)
    s = result.get("summary") or {}
    base = {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
    }
    eq = equity_series(result.get("equityCurve") or [])
    print(base, flush=True)

    print("\n=== circuit breaker grid (portfolio-level) ===", flush=True)
    grid: list[dict] = []
    for peak_w, dd_t, lot_m, pause_d in itertools.product(
        [21, 30],
        [8, 10, 12, 14, 16, 18],
        [0.5, 0.7],
        [7, 14, 21],
    ):
        row = simulate_cb(eq, peak_window_days=peak_w, dd_trigger=dd_t, lot_mult=lot_m, pause_days=pause_d)
        grid.append(row)
    grid.sort(key=lambda x: (-x["ret"], x["dd"], -x["ret2026"]))
    for row in grid[:12]:
        print(
            f"  peak{row['peakWindowDays']}d DD>={row['ddTrigger']}% lot×{row['lotMult']} pause{row['pauseDays']}d "
            f"→ ret={row['ret']}% dd={row['dd']}% 2026={row['ret2026']}% trig={row['triggers']}",
            flush=True,
    )
    best = grid[0]
    best_2026 = max(grid, key=lambda x: (x["ret2026"], -x["dd"]))

    # Tier-scoped simulation note: same CB on equity is portfolio-level only
    print("\n=== DCA presets (v4.1 + SUI/TRX combined) ===", flush=True)
    card = json.load(open(card_path, encoding="utf-8"))
    # offer ids from card + addon - use strategy ids as fallback offer pattern
    offer_ids = list(card.get("offerIds") or [])
    for ad in ADDONS:
        sid = ad["strategyId"]
        mode = "mono" if "/" not in ad["market"] else "synth"
        st = "CT_Fractal" if "CRV" in ad["market"] else "DD_BattleToads"
        oid = f"offer_{mode}_{st.lower()}_{sid}"
        if oid not in offer_ids:
            offer_ids.append(oid)
    dca_results: list[dict] = []
    if os.environ.get("SKIP_DCA") != "1":
        for name, preset in DCA_PRESETS.items():
            try:
                row = run_dca_combo(offer_ids[:17], name, preset)
                dca_results.append(row)
                print(f"  {name}: combined {row['combined']} tsOnly {row['tsOnly']}", flush=True)
            except Exception as exc:
                print(f"  {name}: FAIL {exc}", flush=True)
                dca_results.append({"preset": name, "error": str(exc)})
    else:
        print("  (SKIP_DCA=1)", flush=True)

    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "baselineV41Ts": base,
        "architectureNote": {
            "circuitBreakerLevel": "portfolio",
            "reason": "DD episodes are correlated across 6+ legs simultaneously; per-strategy lot cut misses regime signal. Optional future: tier-scoped (4h_ct only) during portfolio DD.",
            "notRecommended": "per-leg chronic-loser cut without regime context — removes legs that work in other periods",
        },
        "circuitBreakerGridTop12": grid[:12],
        "circuitBreakerBestRet": best,
        "circuitBreakerBest2026": best_2026,
        "dcaPresets": dca_results,
        "dcaNote": "v4/v4.1 pure TS has no DCA. Shield uses v2dca_dense 1h 0.5/1.2 on SUI+TRX.",
    }
    json.dump(doc, open(OUT, "w"), indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT}", flush=True)


if __name__ == "__main__":
    main()

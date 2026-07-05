#!/usr/bin/env python3
"""Margin / concurrent-position diagnostics for v4.4 Safe & B3 presets."""
from __future__ import annotations

import bisect
import json
import os
import sqlite3
import sys
import time
from dataclasses import dataclass
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026').strip()}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db.vps_full"))
RANK = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_cloud_spread_rank_jul2026.json")
OUT = os.path.join(REPO, "results", "v44_margin_op_diag_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
INITIAL, REINVEST = 10000.0, 50.0
CB = {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}

SYNTH_MULT = {
    218660: 0.5, 239276: 0.7, 239282: 0.7, 239292: 0.5,
    241565: 1.0, 241567: 1.0, 242965: 1.0, 242966: 1.0,
    242968: 0.7, 242969: 0.5, 242970: 0.7, 242972: 0.35,
    242973: 1.0, 242974: 0.5, 242976: 0.5, 242977: 0.7,
}

PRESETS = [
    {"name": "Safe", "lot": 30, "op": 32, "tvMult": 2.5, "synthScale": 1.0},
    {"name": "B3", "lot": 50, "op": 44, "tvMult": 2.5, "synthScale": 0.9},
    {"name": "B3_op32", "lot": 50, "op": 32, "tvMult": 2.5, "synthScale": 0.9, "note": "OP matched to Safe"},
    {"name": "Safe_op20", "lot": 30, "op": 20, "tvMult": 2.5, "synthScale": 1.0, "note": "conservative OP"},
]


def api_post(path: str, payload: dict, timeout: int = 1200) -> dict:
    for attempt in range(30):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except requests.RequestException as exc:
            time.sleep(8 + attempt * 2)
            if attempt == 29:
                raise exc
            continue
        err = str(data.get("error") or "")
        if data.get("success") is not False and not err:
            return data
        if "already running" in err.lower():
            time.sleep(15 + attempt * 2)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("lock timeout")


def ensure_tv(conn: sqlite3.Connection, base: str) -> int:
    row = conn.execute(
        "SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id "
        "WHERE ak.name='BTDD_D1' AND s.name=?",
        (f"TV_BURST_15M_{base}",),
    ).fetchone()
    if not row:
        raise RuntimeError(f"missing TV {base}")
    return int(row[0])


def cloud_syms() -> list[str]:
    return list((json.load(open(RANK, encoding="utf-8")).get("pickedSymbols") or [])[:20])


def build_v44(conn: sqlite3.Connection, tv_mult: float, synth_scale: float) -> tuple[list[int], dict[int, float]]:
    tv_ids = [ensure_tv(conn, s) for s in cloud_syms()]
    sids = list(SYNTH_MULT.keys()) + tv_ids
    mul = {sid: float(v) * synth_scale for sid, v in SYNTH_MULT.items()}
    for tid in tv_ids:
        mul[tid] = tv_mult
    return sids, mul


def leverage_map(conn: sqlite3.Connection, sids: list[int]) -> dict[int, float]:
    out: dict[int, float] = {}
    for sid in sids:
        row = conn.execute("SELECT leverage FROM strategies WHERE id=?", (sid,)).fetchone()
        lev = float(row[0]) if row and row[0] else 20.0
        out[sid] = max(1.0, lev)
    return out


@dataclass
class Snap:
    t: int
    open_count: int
    margin_used: float
    notional_open: float
    equity: float


def downsample_curve(curve: list[dict], max_pts: int = 4000) -> list[dict]:
    if len(curve) <= max_pts:
        return curve
    step = max(1, len(curve) // max_pts)
    slim = curve[::step]
    if slim[-1] is not curve[-1]:
        slim.append(curve[-1])
    return slim


def equity_at(curve: list[dict], t_ms: int) -> float:
    if not curve:
        return INITIAL
    times = [int(p["time"]) * 1000 for p in curve]
    vals = [float(p["equity"]) for p in curve]
    i = bisect.bisect_right(times, t_ms) - 1
    if i < 0:
        return vals[0]
    return vals[i]


def analyze(trades: list[dict], lev: dict[int, float], curve: list[dict]) -> dict:
    events: list[tuple[int, int, float, int]] = []  # time, delta, margin, sid
    for tr in trades:
        sid = int(tr.get("strategyId") or 0)
        notional = float(tr.get("notional") or 0)
        if notional <= 0:
            continue
        l = lev.get(sid, 20.0)
        margin = notional / l
        et = int(tr.get("entryTime") or 0)
        xt = int(tr.get("exitTime") or 0)
        if et <= 0 or xt <= 0:
            continue
        events.append((et, +1, margin, sid))
        events.append((xt, -1, margin, sid))
    events.sort(key=lambda x: (x[0], -x[1]))

    open_count = 0
    margin_used = 0.0
    notional_open = 0.0
    snaps: list[Snap] = []
    prev_t = events[0][0] if events else 0
    duration_weighted_open = 0.0
    duration_weighted_margin_pct = 0.0
    total_ms = 0

    for t, delta, margin, _sid in events:
        if t > prev_t and open_count >= 0:
            dt = t - prev_t
            eq = equity_at(curve, prev_t)
            m_pct = (margin_used / eq * 100) if eq > 0 else 0
            duration_weighted_open += open_count * dt
            duration_weighted_margin_pct += m_pct * dt
            total_ms += dt
        open_count += delta
        margin_used += delta * margin
        notional_open += delta * margin * lev.get(_sid, 20.0)
        snaps.append(Snap(t, open_count, max(0, margin_used), max(0, notional_open), equity_at(curve, t)))
        prev_t = t

    if not snaps:
        return {"error": "no trades"}

    open_counts = [s.open_count for s in snaps]
    margin_pcts = [(s.margin_used / s.equity * 100) if s.equity > 0 else 0 for s in snaps]

    def pctile(arr: list[float], p: float) -> float:
        if not arr:
            return 0.0
        a = sorted(arr)
        k = (len(a) - 1) * p / 100.0
        f = int(k)
        c = min(f + 1, len(a) - 1)
        return a[f] + (a[c] - a[f]) * (k - f)

    return {
        "avgOpenPositions": round(duration_weighted_open / total_ms, 2) if total_ms else 0,
        "maxOpenPositions": max(open_counts),
        "p95OpenPositions": round(pctile([float(x) for x in open_counts], 95), 1),
        "p99OpenPositions": round(pctile([float(x) for x in open_counts], 99), 1),
        "avgMarginUsedPct": round(duration_weighted_margin_pct / total_ms, 2) if total_ms else 0,
        "maxMarginUsedPct": round(max(margin_pcts), 2),
        "p95MarginUsedPct": round(pctile(margin_pcts, 95), 2),
        "p99MarginUsedPct": round(pctile(margin_pcts, 99), 2),
        "snapshots": len(snaps),
    }


def run_preset(conn: sqlite3.Connection, spec: dict) -> dict:
    sids, mul = build_v44(conn, spec["tvMult"], spec["synthScale"])
    lev = leverage_map(conn, sids)
    payload = {
        "apiKeyName": "BTDD_D1", "mode": "portfolio", "strategyIds": sids,
        "dateFrom": DATE_FROM, "dateTo": DATE_TO, "bars": 900, "warmupBars": 120,
        "initialBalance": INITIAL, "commissionPercent": 0.1, "slippagePercent": 0.05,
        "maxOpenPositions": spec["op"], "lotPercentOverride": spec["lot"],
        "reinvestPercentOverride": REINVEST,
        "maxDepositOverride": INITIAL * (1 + (REINVEST / 100) * 19),
        "lotPercentMultiplierByStrategyId": {str(k): float(v) for k, v in mul.items()},
        "enablePairLock": True, "skipMissingSymbols": True, "portfolioCircuitBreaker": CB,
    }
    print(f"=== {spec['name']} lot={spec['lot']} op={spec['op']} ===", flush=True)
    res = api_post("/api/backtest/run", payload).get("result") or {}
    summary = res.get("summary") or {}
    trades = res.get("trades") or []
    curve = downsample_curve(res.get("equityCurve") or [])
    diag = analyze(trades, lev, curve)
    row = {
        **spec,
        "ret": round(float(summary.get("totalReturnPercent") or 0), 1),
        "dd": round(float(summary.get("maxDrawdownPercent") or 0), 2),
        "trades": int(summary.get("tradesCount") or 0),
        "skippedByOpLimit": int(summary.get("skippedByPositionLimit") or 0),
        "skippedByPairLock": int(summary.get("skippedByPairLock") or 0),
        **diag,
    }
    print(
        f"  ret={row['ret']}% dd={row['dd']}% avgOpen={row['avgOpenPositions']} "
        f"maxOpen={row['maxOpenPositions']} p99Open={row['p99OpenPositions']} "
        f"avgMargin={row['avgMarginUsedPct']}% p95Margin={row['p95MarginUsedPct']}% "
        f"maxMargin={row['maxMarginUsedPct']}% skippedOP={row['skippedByOpLimit']}",
        flush=True,
    )
    return row


def main() -> None:
    conn = sqlite3.connect(DB)
    rows = [run_preset(conn, p) for p in PRESETS]
    report = {"generatedAt": datetime.now(timezone.utc).isoformat(), "presets": rows}
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()

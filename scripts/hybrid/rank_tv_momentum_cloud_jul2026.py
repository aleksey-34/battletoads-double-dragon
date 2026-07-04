#!/usr/bin/env python3
"""
Rank TV momentum cloud sweep → pick spread portfolio → lot/OP grid (modest lot).

  python3 scripts/hybrid/rank_tv_momentum_cloud_jul2026.py
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from datetime import datetime, timezone
from itertools import product

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SWEEP = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_momentum_cloud_sweep_jul2026.json")
OUT_DIR = os.path.join(REPO, "results", "tv_momentum_cloud")
OUT = os.path.join(OUT_DIR, "tv_cloud_spread_rank_jul2026.json")
SIM = os.path.join(REPO, "scripts", "hybrid", "sim_tv_cloud_portfolio.mjs")
BUNDLE = os.environ.get("HYBRID_CANDLE_DIR", os.path.join(REPO, "results", "hybrid_candle_bundle_15m"))

MIN_EP4 = float(os.environ.get("MIN_EP4_RET", "3"))
MIN_EP3 = float(os.environ.get("MIN_EP3_RET", "-50"))
MIN_TRADES = int(os.environ.get("MIN_FULL_TRADES", "70"))
MAX_TRADES = int(os.environ.get("MAX_FULL_TRADES", "450"))
MAX_FULL_RET = float(os.environ.get("MAX_FULL_RET", "2500"))
MAX_EP4_RET = float(os.environ.get("MAX_EP4_RET", "800"))
TOP_N = int(os.environ.get("CLOUD_TOP_N", "20"))
CORE = ["SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT", "WIFUSDT"]


def score(row: dict) -> float:
    ep4 = row.get("ep4") or {}
    ep3 = row.get("ep3") or {}
    full = row.get("full") or {}
    return (
        float(ep4.get("ret") or 0) * 1.2
        + float(ep3.get("ret") or 0)
        + float(full.get("ret") or 0) * 0.25
        - float(full.get("dd") or 0) * 0.6
        + min(int(full.get("trades") or 0), 500) * 0.015
        + (float(full.get("pf") or 0) - 1) * 8
    )


def eligible(row: dict) -> bool:
    if row.get("skip"):
        return False
    ep4 = row.get("ep4") or {}
    ep3 = row.get("ep3") or {}
    full = row.get("full") or {}
    tr = int(full.get("trades") or 0)
    return (
        float(ep4.get("ret") or 0) >= MIN_EP4
        and float(ep3.get("ret") or 0) >= MIN_EP3
        and MIN_TRADES <= tr <= MAX_TRADES
        and float(full.get("ret") or 0) <= MAX_FULL_RET
        and float(ep4.get("ret") or 0) <= MAX_EP4_RET
        and float(full.get("dd") or 0) <= float(os.environ.get("MAX_FULL_DD", "22"))
        and float(full.get("pf") or 0) >= float(os.environ.get("MIN_PF", "1.12"))
    )


def dual_eligible(row: dict) -> bool:
    if row.get("skip"):
        return False
    ep4 = row.get("ep4") or {}
    ep3 = row.get("ep3") or {}
    full = row.get("full") or {}
    tr = int(full.get("trades") or 0)
    return (
        float(ep4.get("ret") or 0) >= 40
        and float(ep3.get("ret") or 0) >= 20
        and 900 <= tr <= 1700
        and float(full.get("dd") or 0) <= 20
        and float(ep4.get("ret") or 0) <= 2000
    )


def run_sim(symbols: list[str], lot: float, op: int) -> dict:
    sym_file = os.path.join(OUT_DIR, "_pick_symbols.json")
    out_file = os.path.join(OUT_DIR, f"_sim_l{lot}_op{op}.json")
    json.dump(symbols, open(sym_file, "w", encoding="utf-8"))
    env = {**os.environ, "HYBRID_CANDLE_DIR": BUNDLE}
    subprocess.run(
        ["node", SIM, sym_file, str(lot), str(op), out_file],
        cwd=REPO,
        env=env,
        check=True,
        capture_output=True,
        text=True,
    )
    return json.load(open(out_file, encoding="utf-8"))


def main() -> None:
    if not os.path.isfile(SWEEP):
        print(f"missing sweep: {SWEEP}", file=sys.stderr)
        sys.exit(1)

    sweep = json.load(open(SWEEP, encoding="utf-8"))
    all_rows = [r for r in (sweep.get("all") or []) if not r.get("skip")]
    sanity = [r for r in all_rows if eligible(r)]
    sanity.sort(key=score, reverse=True)
    dual = [r for r in all_rows if dual_eligible(r)]
    dual.sort(key=lambda r: r["ep4"]["ret"] + r["ep3"]["ret"] * 0.5, reverse=True)

    picked: list[str] = []
    for sym in CORE:
        if sym not in picked and any(r["sym"] == sym for r in all_rows):
            picked.append(sym)
    for pool in (sanity, dual):
        for r in pool:
            sym = r["sym"]
            if sym in picked:
                continue
            picked.append(sym)
            if len(picked) >= TOP_N:
                break
        if len(picked) >= TOP_N:
            break

    lots = [float(x) for x in os.environ.get("CLOUD_LOTS", "12,15,18,22").split(",")]
    ops = [int(x) for x in os.environ.get("CLOUD_OPS", "10,12,16,20").split(",")]
    grid: list[dict] = []
    for lot, op in product(lots, ops):
        if op < min(8, len(picked) // 2):
            continue
        try:
            sim = run_sim(picked, lot, op)
        except subprocess.CalledProcessError as exc:
            print(f"sim fail lot={lot} op={op}: {exc.stderr[-200:]}", file=sys.stderr)
            continue
        grid.append({"lot": lot, "op": op, **sim})
        print(
            f"  lot={lot:4.0f} op={op:2d} ret={sim['ret']:8.1f}% dd={sim['dd']:5.1f}% tr={sim['trades']:5d} ep4={sim['ep4']['ret']:+.1f}%",
            flush=True,
        )

    # Prefer: DD <= 18%, max ret; else best ret with DD <= 25%
    under18 = [g for g in grid if g["dd"] <= 18 and g["ret"] > 0]
    under25 = [g for g in grid if g["dd"] <= 25 and g["ret"] > 0]
    pool = under18 or under25 or grid
    pool.sort(key=lambda g: (-g["ret"], g["dd"], -g["trades"]))
    best = pool[0] if pool else {}

    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "filters": {
            "minEp4": MIN_EP4, "minEp3": MIN_EP3,
            "minTrades": MIN_TRADES, "maxTrades": MAX_TRADES,
            "maxFullRet": MAX_FULL_RET, "maxEp4Ret": MAX_EP4_RET,
        },
        "eligibleCount": len(sanity),
        "dualModerateCount": len(dual),
        "pickedSymbols": picked,
        "pickedDetails": [r for r in all_rows if r["sym"] in picked],
        "sanityPool": sanity[:30],
        "dualPool": dual[:15],
        "sizingGrid": grid,
        "recommended": best,
    }
    os.makedirs(OUT_DIR, exist_ok=True)
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"\nPicked {len(picked)} legs: {', '.join(picked)}")
    if best:
        print(f"Recommended: lot={best.get('lot')}% OP={best.get('maxOpenPositions')} ret={best.get('ret')}% dd={best.get('dd')}%")
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()

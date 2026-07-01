#!/usr/bin/env python3
"""
Union v3b grid: leg-set × reinvest × DCA × OP on honest 732d window (2024-06-01).

ZZ_Fast / ZZ_Instance on synthetic pairs trade ratio decorrelation trend — hedged
long/short legs → closer to market-neutral than mono CT. We test that empirically
vs stat_arb-only and mixed stacks.

  python3 scripts/admin_tools/storefront/research_union_v3b_grid_jul2026.py --quick
  python3 scripts/admin_tools/storefront/research_union_v3b_grid_jul2026.py --full
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from itertools import product

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = {
    "Authorization": f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026')}",
    "Content-Type": "application/json",
}
REPO = os.environ.get("BTDD_REPO", "/opt/battletoads-double-dragon")
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
DATE_FROM = os.environ.get("UNION_RESEARCH_FROM", "2024-06-01")
DATE_TO = os.environ.get("UNION_RESEARCH_TO", datetime.now(timezone.utc).date().isoformat())
SET_KEY = "union-synth-heavy-jun2026-v3"
SYSTEM = "ALGOFUND_MASTER::BTDD_D1::union-synth-heavy-jun2026-v3-qzwjsh"

SWEEP_FILES = [
    "btdd_d1_historical_sweep_2026-07-01T20-53-15-730Z.json",
    "btdd_d1_historical_sweep_2026-07-01T20-46-18-697Z.json",
    "btdd_d1_historical_sweep_2026-07-01T17-11-55-932Z.json",
    "btdd_d1_historical_sweep_2026-07-01T16-19-01-575Z.json",
    "btdd_d1_historical_sweep_2026-06-16T10-43-14-084Z.json",
]

V2_MACRO = {
    "anchorInterval": "1h", "rules": [], "localSelf": {
        "source": "self", "rsiPeriod": 14, "fractalWings": 2, "mode": "partial",
        "closeFraction": 0.35, "combineWith": "or",
        "longExitRsiAbove": 70, "shortExitRsiBelow": 20, "shortExitRsiAbove": 70,
        "label": "local_rsi1h",
    },
}
STAT_GATE = {
    "gateInterval": "4h", "fractalWings": 2, "lookbackBars": 12,
    "longRequireBullishFractal": True, "shortRequireBearishFractal": True,
    "label": "self_frac4h_lb12",
}
DCA_TUNING = {
    "interval": "1h", "stepPercent": 0.5,
    "tpPercent": 1.2, "slPercent": 0, "entryFilter": "always", "perLegSl": False,
}


def db_type(stype: str) -> str:
    return {
        "ct_fractal": "CT_Fractal",
        "zz_fast": "ZZ_Fast",
        "zz_instance": "ZZ_Instance",
        "stat_arb_zscore": "stat_arb_zscore",
    }.get(stype, stype)


def leg_strategy_id(conn: sqlite3.Connection, row: dict, stype: str, market: str, mode: str = "synth") -> int | None:
    """Prefer sweep-evaluated strategyId (has candle data); fallback to DB lookup."""
    sid = int(row.get("strategyId") or 0)
    if sid > 0:
        hit = conn.execute("SELECT id FROM strategies WHERE id=?", (sid,)).fetchone()
        if hit:
            return sid
    return resolve_db_id(conn, stype, market, mode=mode)


def resolve_db_id(conn: sqlite3.Connection, stype: str, market: str, mode: str = "synth") -> int | None:
    dt = db_type(stype)
    base, _, quote = market.partition("/")
    if not quote and base:
        if mode == "mono":
            row = conn.execute(
                """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
                   WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=?
                     AND s.strategy_type=? AND COALESCE(s.quote_symbol,'')=''
                   ORDER BY s.id DESC LIMIT 1""",
                (base, dt),
            ).fetchone()
            return int(row[0]) if row else None
        row = conn.execute(
            """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
               WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=? AND s.strategy_type=?
               ORDER BY s.id DESC LIMIT 1""",
            (base, dt),
        ).fetchone()
        return int(row[0]) if row else None
    row = conn.execute(
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=? AND s.quote_symbol=?
             AND s.strategy_type=?
           ORDER BY s.id DESC LIMIT 1""",
        (base, quote, dt),
    ).fetchone()
    return int(row[0]) if row else None


def load_rows() -> list[dict]:
    rows: list[dict] = []
    for fname in SWEEP_FILES:
        path = os.path.join(REPO, "results", fname)
        if not os.path.isfile(path):
            continue
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        rows.extend(doc.get("evaluated") or [])
    return rows


def row_rank(r: dict) -> tuple:
    return (
        1 if r.get("robust") else 0,
        -float(r.get("maxDrawdownPercent") or 99),
        float(r.get("totalReturnPercent") or 0),
        int(r.get("tradesCount") or r.get("trades") or 0),
    )


def pick_pool(
    rows: list[dict],
    *,
    stype: str,
    mode: str = "synth",
    max_dd: float = 28.0,
    cap: int = 8,
    seen_markets: set[str] | None = None,
) -> list[tuple[str, str, int, str]]:
    dt = db_type(stype)
    want_mode = mode.lower()
    pool = [
        r for r in rows
        if str(r.get("strategyType") or "") == dt
        and str(r.get("marketMode") or "").lower() == want_mode
        and float(r.get("maxDrawdownPercent") or 99) <= max_dd
        and int(r.get("tradesCount") or r.get("trades") or 0) > 0
        and ("/" in str(r.get("market") or "") if want_mode == "synth" else True)
    ]
    if want_mode == "mono":
        pool = [r for r in pool if "/" not in str(r.get("market") or "")]
    pool.sort(key=row_rank, reverse=True)
    seen = seen_markets if seen_markets is not None else set()
    out: list[tuple[str, str, int, str]] = []
    conn = sqlite3.connect(DB)
    for r in pool:
        market = str(r.get("market") or "")
        if not market or market in seen:
            continue
        st_key = stype
        mode_key = "mono" if want_mode == "mono" else "synth"
        sid = leg_strategy_id(conn, r, st_key, market, mode=mode_key)
        if not sid:
            continue
        out.append((mode_key, st_key, sid, market))
        seen.add(market)
        if len(out) >= cap:
            break
    conn.close()
    return out


def load_decorr_priority() -> list[str]:
    path = os.environ.get(
        "DECORR_SCORES_JSON",
        os.path.join(REPO, "results", "synth_pair_decorrelation_latest.json"),
    )
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for key in ("synthMarketsForSweep", "topMarkets"):
            raw = doc.get(key)
            if isinstance(raw, list) and raw:
                return [str(m).strip() for m in raw if str(m).strip()]
    return []


def _market_prio(market: str, priority: list[str]) -> int:
    m = str(market or "").strip()
    try:
        return priority.index(m)
    except ValueError:
        return 999


def pick_pool_v3c(
    rows: list[dict],
    *,
    stype: str,
    mode: str = "synth",
    max_dd: float = 28.0,
    cap: int = 8,
    seen_markets: set[str],
    priority: list[str],
) -> list[tuple[str, str, int, str]]:
    dt = db_type(stype)
    want_mode = mode.lower()
    pool = [
        r for r in rows
        if str(r.get("strategyType") or "") == dt
        and str(r.get("marketMode") or "").lower() == want_mode
        and float(r.get("maxDrawdownPercent") or 99) <= max_dd
        and int(r.get("tradesCount") or r.get("trades") or 0) > 0
        and ("/" in str(r.get("market") or "") if want_mode == "synth" else True)
    ]
    pool.sort(key=lambda r: (_market_prio(str(r.get("market") or ""), priority),) + tuple(-x for x in row_rank(r)))
    out: list[tuple[str, str, int, str]] = []
    conn = sqlite3.connect(DB)
    for r in pool:
        market = str(r.get("market") or "")
        if not market or market in seen_markets:
            continue
        mode_key = "mono" if want_mode == "mono" else "synth"
        sid = leg_strategy_id(conn, r, stype, market, mode=mode_key)
        if not sid:
            continue
        out.append((mode_key, stype, sid, market))
        seen_markets.add(market)
        if len(out) >= cap:
            break
    conn.close()
    return out


def build_leg_set_v3c(rows: list[dict], *, max_legs: int = 32, max_dd: float = 28.0) -> list[tuple[str, str, int, str]]:
    """Decorr-priority union: one leg per ratio market, stat → CT → ZZ."""
    priority = load_decorr_priority()
    seen: set[str] = set()
    legs: list[tuple[str, str, int, str]] = []
    for stype, cap in (
        ("stat_arb_zscore", 12),
        ("ct_fractal", 12),
        ("zz_fast", 8),
        ("zz_instance", 6),
    ):
        legs.extend(
            pick_pool_v3c(
                rows,
                stype=stype,
                mode="synth",
                max_dd=max_dd,
                cap=cap,
                seen_markets=seen,
                priority=priority,
            )
        )
        if len(legs) >= max_legs:
            break
    return legs[:max_legs]


def build_leg_sets(rows: list[dict]) -> dict[str, list[tuple[str, str, int, str]]]:
    seen: set[str] = set()
    stat = pick_pool(rows, stype="stat_arb_zscore", cap=10, seen_markets=seen)
    zz_fast = pick_pool(rows, stype="zz_fast", cap=6, seen_markets=set())
    zz_inst = pick_pool(rows, stype="zz_instance", cap=6, seen_markets=set())
    # allow same market for fast+instance (different engine)
    ct_synth = pick_pool(rows, stype="ct_fractal", mode="synth", cap=8, seen_markets=set())
    ct_mono = pick_pool(rows, stype="ct_fractal", mode="mono", cap=4, max_dd=25.0, seen_markets=set())

    zz_all = zz_fast + zz_inst
    stat_zz = stat + zz_all
    stat_zz_ct = stat_zz + ct_synth
    full_no_mono = stat_zz_ct
    full_with_mono = stat_zz_ct + ct_mono

    def dedupe(legs: list[tuple[str, str, int, str]]) -> list[tuple[str, str, int, str]]:
        seen_k: set[tuple[str, int]] = set()
        out: list[tuple[str, str, int, str]] = []
        for mode, st, sid, m in legs:
            k = (st, sid)
            if k in seen_k:
                continue
            seen_k.add(k)
            out.append((mode, st, sid, m))
        return out

    return {
        "stat_arb_10": dedupe(stat),
        "zz_12": dedupe(zz_all),
        "stat_zz_22": dedupe(stat_zz),
        "stat_zz_ct_30": dedupe(stat_zz_ct),
        "stat_zz_ct_v3c": build_leg_set_v3c(rows, max_legs=int(os.environ.get("V3C_MAX_LEGS", "32"))),
        "full_no_mono_30": dedupe(full_no_mono),
        "full_mono_34": dedupe(full_with_mono),
    }


def legs_to_offers(legs: list[tuple[str, str, int, str]]) -> tuple[list[str], dict[str, float]]:
    offer_ids = [f"offer_{mode}_{stype}_{sid}" for mode, stype, sid, _ in legs]
    w = round(1 / max(1, len(offer_ids)), 6)
    weights = {oid: w for oid in offer_ids}
    return offer_ids, weights


def max_deposit(reinvest: float, balance: float = 10000.0) -> float:
    if reinvest <= 0:
        return 0.0
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0)
    return balance * growth


def run_ts_portfolio(
    strategy_ids: list[int],
    weights: dict[str, float],
    offer_ids: list[str],
    *,
    reinvest: float,
    op: int,
    lot: float = 20.0,
) -> dict:
    mul: dict[str, float] = {}
    w = round(1 / max(1, len(strategy_ids)), 6)
    for sid in strategy_ids:
        mul[str(sid)] = w
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": strategy_ids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 900,
        "warmupBars": 120,
        "initialBalance": 10000,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "maxDepositOverride": max_deposit(reinvest),
        "reinvestPercentOverride": reinvest,
        "lotPercentMultiplierByStrategyId": mul,
        "enablePairLock": True,
        "macroExitOverlay": V2_MACRO,
        "statArbEntryGate": STAT_GATE,
        "skipMissingSymbols": True,
    }
    r = requests.post(f"{API}/api/backtest/run", headers=AUTH, json=payload, timeout=900)
    if r.status_code >= 400:
        raise RuntimeError(f"backtest/run -> {r.status_code}: {r.text[:400]}")
    data = r.json()
    if not data.get("success"):
        raise RuntimeError(f"backtest failed: {data.get('error') or data}")
    s = (data.get("result") or {}).get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "tsTrades": int(s.get("tradesCount") or 0),
    }


DCA_STRATEGY_IDS = [241605, 241606]  # SUI + TRX scratch DCA on BTDD_D1


def run_cell(
    leg_label: str,
    legs: list[tuple[str, str, int, str]],
    *,
    reinvest: float,
    op: int,
    dca: bool,
    lot: float = 20.0,
) -> dict:
    offer_ids, weights = legs_to_offers(legs)
    strategy_ids = [sid for _, _, sid, _ in legs]
    ts_count = len(strategy_ids)
    if dca:
        strategy_ids = [*strategy_ids, *DCA_STRATEGY_IDS]
    t0 = time.time()
    metrics = run_ts_portfolio(strategy_ids, weights, offer_ids, reinvest=reinvest, op=op, lot=lot)
    elapsed = round(time.time() - t0, 1)
    ret, dd, trades = metrics["ret"], metrics["dd"], metrics["trades"]
    pf = metrics["pf"]
    ts_trades = metrics["tsTrades"]
    # score: reward ret + trades, penalize DD > 25
    dd_pen = max(0, dd - 25) * 8
    trade_bonus = min(trades, 500) * 0.02
    score = ret - dd_pen + trade_bonus
    return {
        "legSet": leg_label,
        "legs": ts_count,
        "reinvest": reinvest,
        "dca": dca,
        "op": op,
        "ret": round(ret, 2),
        "dd": round(dd, 2),
        "pf": round(pf, 3),
        "trades": trades,
        "tsTrades": ts_trades,
        "score": round(score, 2),
        "sec": elapsed,
    }


def print_table(rows: list[dict], top: int = 25) -> None:
    rows_sorted = sorted(rows, key=lambda r: (r["score"], r["ret"], -r["dd"]), reverse=True)
    print(f"\n{'='*110}")
    print(f"TOP {top} by score (ret - DD_penalty + trade_bonus)  window={DATE_FROM}..{DATE_TO}")
    print(f"{'='*110}")
    hdr = f"{'legSet':<18} {'legs':>4} {'reinv':>5} {'dca':>4} {'OP':>3} {'ret%':>8} {'DD%':>7} {'PF':>6} {'trades':>7} {'tsTr':>6} {'score':>7}"
    print(hdr)
    print("-" * len(hdr))
    for r in rows_sorted[:top]:
        print(
            f"{r['legSet']:<18} {r['legs']:>4} {r['reinvest']:>5.0f} {str(r['dca']):>4} {r['op']:>3} "
            f"{r['ret']:>8.2f} {r['dd']:>7.2f} {r['pf']:>6.3f} {r['trades']:>7} {r['tsTrades']:>6} {r['score']:>7.2f}"
        )


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--quick", action="store_true", help="Smaller grid (~48 runs)")
    parser.add_argument("--full", action="store_true", help="Large grid (~200+ runs)")
    parser.add_argument("--limit-leg-sets", type=str, default="", help="Comma leg set keys")
    parser.add_argument("--resume", type=str, default="", help="Resume from existing JSON path")
    args = parser.parse_args()

    rows = load_rows()
    leg_sets = build_leg_sets(rows)
    print("Leg pools:")
    for k, legs in leg_sets.items():
        print(f"  {k}: {len(legs)} legs")
        for mode, st, sid, m in legs[:4]:
            print(f"    {mode}/{st} #{sid} {m}")
        if len(legs) > 4:
            print(f"    ... +{len(legs)-4} more")

    if args.limit_leg_sets.strip():
        keep = {x.strip() for x in args.limit_leg_sets.split(",") if x.strip()}
        leg_sets = {k: v for k, v in leg_sets.items() if k in keep}

    if args.full:
        reinvests = [0, 10, 20, 50, 75, 100]
        dca_opts = [False, True]
        ops = [6, 8, 10, 12, 15, 18, 22]
        leg_keys = list(leg_sets.keys())
    elif args.quick:
        reinvests = [0, 20, 50, 100]
        dca_opts = [False, True]
        ops = [8, 12, 18]
        leg_keys = ["stat_arb_10", "zz_12", "stat_zz_22", "stat_zz_ct_30"]
    else:
        reinvests = [0, 20, 50, 100]
        dca_opts = [False, True]
        ops = [8, 10, 12, 15, 18]
        leg_keys = ["stat_arb_10", "stat_zz_22", "stat_zz_ct_30", "full_no_mono_30"]

    grid = list(product(leg_keys, reinvests, dca_opts, ops))
    print(f"\nGrid: {len(grid)} cells (engine=api/backtest/run portfolio, window={DATE_FROM}..{DATE_TO})\n")

    out_path = args.resume.strip() if args.resume.strip() else os.path.join(
        REPO, "results", f"union_v3b_grid_{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%S')}.json",
    )
    results: list[dict] = []
    done_keys: set[str] = set()
    if args.resume and os.path.isfile(args.resume):
        with open(args.resume, encoding="utf-8") as f:
            prev = json.load(f).get("results") or []
        for r in prev:
            if r.get("error"):
                continue
            if float(r.get("trades") or 0) <= 0 and float(r.get("ret") or 0) == 0:
                continue  # stale broken cells from old engine
            key = f"{r['legSet']}|r{int(r['reinvest'])}|dca{'Y' if r['dca'] else 'N'}|op{r['op']}"
            done_keys.add(key)
            results.append(r)
        print(f"Resumed {len(results)} completed cells from {args.resume}")

    for i, (lk, reinvest, dca, op) in enumerate(grid, 1):
        legs = leg_sets.get(lk) or []
        if not legs:
            continue
        label = f"{lk}|r{int(reinvest)}|dca{'Y' if dca else 'N'}|op{op}"
        if label in done_keys:
            print(f"[{i}/{len(grid)}] skip {label}", flush=True)
            continue
        print(f"[{i}/{len(grid)}] {label} ({len(legs)} legs)...", flush=True)
        try:
            row = run_cell(lk, legs, reinvest=reinvest, op=op, dca=dca)
            results.append(row)
            print(f"    ret={row['ret']}% dd={row['dd']}% trades={row['trades']} score={row['score']}", flush=True)
        except Exception as exc:
            print(f"    ERR: {exc}", flush=True)
            results.append({
                "legSet": lk, "legs": len(legs), "reinvest": reinvest, "dca": dca, "op": op,
                "ret": 0, "dd": 99, "pf": 0, "trades": 0, "tsTrades": 0, "score": -999, "error": str(exc),
            })
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump({
                "window": [DATE_FROM, DATE_TO],
                "legSets": {k: len(v) for k, v in leg_sets.items()},
                "results": results,
            }, f, indent=2)

    with open(out_path, "w", encoding="utf-8") as f:
        json.dump({"window": [DATE_FROM, DATE_TO], "legSets": {k: len(v) for k, v in leg_sets.items()}, "results": results}, f, indent=2)
    print(f"\nSaved: {out_path}")
    print_table(results, top=30)

    # ablation summary by leg family (best per leg set)
    print(f"\n{'='*80}")
    print("Best per leg-set (any reinvest/dca/op):")
    by_set: dict[str, dict] = {}
    for r in results:
        if r.get("error"):
            continue
        prev = by_set.get(r["legSet"])
        if not prev or r["score"] > prev["score"]:
            by_set[r["legSet"]] = r
    for lk in leg_keys:
        r = by_set.get(lk)
        if not r:
            continue
        print(
            f"  {lk}: ret={r['ret']}% dd={r['dd']}% trades={r['trades']} "
            f"reinv={r['reinvest']} dca={r['dca']} op={r['op']} score={r['score']}"
        )


if __name__ == "__main__":
    main()

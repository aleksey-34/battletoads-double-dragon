#!/usr/bin/env python3
"""
Cloud Stars blend — high-PF «звёзды» (high trades/ret) at reduced leg weight vs current pick.

  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/research_cloud_stars_blend_jul2026.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = f"Bearer {os.environ.get('ADMIN_SWEEP_TOKEN', 'btdd_admin_sweep_2026').strip()}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db.vps_full"))
EXPAND = os.path.join(REPO, "results", "tv_momentum_cloud", "cloud_expand_research_jul2026.json")
RANK = os.path.join(REPO, "results", "tv_momentum_cloud", "tv_cloud_spread_rank_jul2026.json")
OUT = os.path.join(REPO, "results", "tv_momentum_cloud", "cloud_stars_blend_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
INITIAL = 10000.0
CB = {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}

CORE = ["SUIUSDT", "DOGEUSDT", "SOLUSDT", "CRVUSDT", "WIFUSDT"]
MIN_PF = float(os.environ.get("STARS_MIN_PF", "1.15"))
MIN_EP4 = float(os.environ.get("STARS_MIN_EP4", "15"))
MIN_EP3 = float(os.environ.get("STARS_MIN_EP3", "-40"))
MAX_DD = float(os.environ.get("STARS_MAX_DD", "20"))
MIN_TRADES = int(os.environ.get("STARS_MIN_TRADES", "70"))


def score(row: dict) -> float:
    ep4, ep3, full = row["ep4"], row["ep3"], row["full"]
    return (
        float(ep4["ret"]) * 1.2 + float(ep3["ret"]) + float(full["ret"]) * 0.25
        - float(full["dd"]) * 0.6 + (float(full["pf"]) - 1) * 12
    )


def strict_eligible(row: dict) -> bool:
    ep4, ep3, full = row["ep4"], row["ep3"], row["full"]
    tr = int(full["trades"])
    return (
        float(ep4["ret"]) >= 3 and float(ep3["ret"]) >= -50
        and 70 <= tr <= 450 and float(full["ret"]) <= 2500
        and float(ep4["ret"]) <= 800 and float(full["dd"]) <= 22
        and float(full["pf"]) >= 1.12
    )


def pf_good(row: dict) -> bool:
    ep4, ep3, full = row["ep4"], row["ep3"], row["full"]
    return (
        float(full["pf"]) >= MIN_PF
        and float(ep4["ret"]) >= MIN_EP4
        and float(ep3["ret"]) >= MIN_EP3
        and float(full["dd"]) <= MAX_DD
        and int(full["trades"]) >= MIN_TRADES
    )


def star_weight(row: dict) -> float:
    """Lower weight for high trades / ret / ep4 — keeps PF-good stars in portfolio."""
    full, ep4 = row["full"], row["ep4"]
    tr, ret, e4, dd, pf = int(full["trades"]), float(full["ret"]), float(ep4["ret"]), float(full["dd"]), float(full["pf"])
    w = 1.0
    if tr > 450:
        w *= max(0.28, min(0.75, 450 / tr))
    if ret > 2500:
        w *= max(0.25, min(0.75, 2500 / ret))
    if e4 > 800:
        w *= max(0.30, min(0.80, 800 / e4))
    if dd > 15:
        w *= max(0.55, 1.0 - (dd - 15) * 0.04)
    if pf >= 1.35:
        w = min(1.0, w * 1.08)
    return round(max(0.22, min(1.0, w)), 2)


def build_stars_blend(rows: list[dict], n_stars: int = 10) -> list[dict]:
    by_sym = {r["sym"]: r for r in rows}
    picked: list[dict] = []
    used: set[str] = set()

    def add(sym: str, mult: float | None = None, tier: str = "moderate") -> None:
        if sym in used or sym not in by_sym:
            return
        r = by_sym[sym]
        m = star_weight(r) if mult is None else mult
        if strict_eligible(r) and tier == "moderate":
            m = 1.0
        picked.append({"sym": sym, "mult": m, "tier": tier, "pf": r["full"]["pf"], "trades": r["full"]["trades"],
                        "ret": r["full"]["ret"], "dd": r["full"]["dd"], "ep4": r["ep4"]["ret"]})
        used.add(sym)

    # CORE anchors — reduced if hot
    for sym in CORE:
        if sym in by_sym and pf_good(by_sym[sym]):
            add(sym, tier="core")

    # PF-good stars that fail strict caps (high trades/ret)
    hot = sorted(
        [r for r in rows if pf_good(r) and not strict_eligible(r)],
        key=score,
        reverse=True,
    )
    for r in hot:
        if len([p for p in picked if p["tier"] == "star"]) >= n_stars:
            break
        add(r["sym"], tier="star")

    # Fill with strict eligible
    moderate = sorted([r for r in rows if strict_eligible(r)], key=score, reverse=True)
    for r in moderate:
        if len(picked) >= 20:
            break
        add(r["sym"], tier="moderate")

    # Last resort: any pf_good
    if len(picked) < 20:
        for r in sorted(rows, key=score, reverse=True):
            if len(picked) >= 20:
                break
            if pf_good(r):
                add(r["sym"], tier="fill")

    return picked[:20]


def build_stars_max(rows: list[dict]) -> list[dict]:
    """12 stars + 8 best moderate — aggressive blend."""
    blend = build_stars_blend(rows, n_stars=12)
    by_sym = {r["sym"]: r for r in rows}
    stars = sorted([p for p in blend if p["tier"] == "star"], key=lambda x: -x["ret"])
    core_mod = [p for p in blend if p["tier"] in ("core", "moderate")]
    out = stars[:12]
    used = {p["sym"] for p in out}
    for p in core_mod:
        if len(out) >= 20:
            break
        if p["sym"] not in used:
            out.append(p)
            used.add(p["sym"])
    moderate = sorted([r for r in rows if strict_eligible(r)], key=score, reverse=True)
    for r in moderate:
        if len(out) >= 20:
            break
        if r["sym"] not in used:
            out.append({"sym": r["sym"], "mult": 1.0, "tier": "moderate",
                        "pf": r["full"]["pf"], "trades": r["full"]["trades"],
                        "ret": r["full"]["ret"], "dd": r["full"]["dd"], "ep4": r["ep4"]["ret"]})
            used.add(r["sym"])
    return out[:20]


def api_post(path: str, payload: dict, timeout: int = 1200) -> dict:
    for attempt in range(30):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except requests.RequestException:
            time.sleep(10 + attempt * 2)
            continue
        err = str(data.get("error") or "")
        body = data.get("result") or data
        if data.get("success") is not False and not err and body.get("summary"):
            return body
        if "already running" in err.lower():
            time.sleep(15 + attempt * 2)
            continue
        raise RuntimeError(err or str(data)[:400])
    raise RuntimeError("lock timeout")


def ensure_tv(conn: sqlite3.Connection, sym: str) -> int:
    name = f"TV_BURST_15M_{sym}"
    row = conn.execute(
        "SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id "
        "WHERE ak.name='BTDD_D1' AND s.name=?",
        (name,),
    ).fetchone()
    if row:
        return int(row[0])
    ak = conn.execute("SELECT id FROM api_keys WHERE name='BTDD_D1'").fetchone()
    if not ak:
        raise RuntimeError("missing BTDD_D1 api key")
    conn.execute(
        """INSERT INTO strategies (
            name, api_key_id, strategy_type, market_mode, base_symbol, quote_symbol, interval,
            price_channel_length, zscore_entry, zscore_exit, zscore_stop, take_profit_percent,
            long_enabled, short_enabled, lot_long_percent, lot_short_percent, is_active,
            display_on_chart, show_settings, show_chart, show_indicators, show_positions_on_chart,
            auto_update, reinvest_percent, leverage, margin_type, detection_source, state
        ) VALUES (?, ?, 'momentum_scalp_tv', 'mono', ?, '', '15m',
            8, 21, 20, 1.2, 2.0, 1, 1, 100, 100, 0, 0, 1, 0, 0, 0, 1, 100, 20, 'cross', 'close', 'flat')""",
        (name, int(ak[0]), sym),
    )
    conn.commit()
    return int(conn.execute("SELECT id FROM strategies WHERE name=? AND api_key_id=?", (name, int(ak[0]))).fetchone()[0])


def run_portfolio(conn: sqlite3.Connection, legs: list[dict], lot: float, op: int, reinvest: float) -> dict:
    sids, mul = [], {}
    for leg in legs:
        sid = ensure_tv(conn, leg["sym"])
        sids.append(sid)
        mul[sid] = float(leg["mult"])
    growth = min(20.0, 1.0 + (reinvest / 100.0) * 19.0)
    payload = {
        "apiKeyName": "BTDD_D1", "mode": "portfolio", "strategyIds": sids,
        "dateFrom": DATE_FROM, "dateTo": DATE_TO, "bars": 900, "warmupBars": 120,
        "initialBalance": INITIAL, "commissionPercent": 0.1, "slippagePercent": 0.05,
        "maxOpenPositions": op, "lotPercentOverride": lot, "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL * growth,
        "lotPercentMultiplierByStrategyId": {str(k): v for k, v in mul.items()},
        "enablePairLock": True, "skipMissingSymbols": True, "portfolioCircuitBreaker": CB,
    }
    s = (api_post("/api/backtest/run", payload).get("summary") or {})
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 1),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "trades": int(s.get("tradesCount") or 0),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "skippedOp": int(s.get("skippedByPositionLimit") or 0),
    }


def main() -> None:
    expand = json.load(open(EXPAND, encoding="utf-8"))
    rows = expand["baselineAll"]
    rank = json.load(open(RANK, encoding="utf-8"))
    current_syms = rank["pickedSymbols"][:20]

    pf_pool = [r for r in rows if pf_good(r)]
    strict_n = sum(1 for r in rows if strict_eligible(r))
    hot_n = sum(1 for r in pf_pool if not strict_eligible(r))

    picks = {
        "current": [{"sym": s, "mult": 1.0, "tier": "current"} for s in current_syms],
        "stars_blend": build_stars_blend(rows, n_stars=10),
        "stars_max": build_stars_max(rows),
    }

    presets = [
        {"label": "modest", "lot": 35, "op": 28, "reinvest": 75},
        {"label": "E1", "lot": 75, "op": 48, "reinvest": 75},
    ]

    conn = sqlite3.connect(DB)
    results: list[dict] = []
    for pick_name, legs in picks.items():
        for ps in presets:
            label = f"{pick_name}_{ps['label']}"
            print(f"=== {label} ({len(legs)} legs) ===", flush=True)
            try:
                row = run_portfolio(conn, legs, ps["lot"], ps["op"], ps["reinvest"])
            except Exception as exc:
                print(f"  skip: {exc}", file=sys.stderr, flush=True)
                continue
            stars = sum(1 for l in legs if l.get("tier") == "star")
            avg_mult = round(sum(l["mult"] for l in legs) / len(legs), 2)
            entry = {
                "pick": pick_name, "preset": ps["label"], "lot": ps["lot"], "op": ps["op"],
                "reinvest": ps["reinvest"], "legs": len(legs), "stars": stars, "avgMult": avg_mult,
                **row,
                "symbols": [l["sym"] for l in legs],
                "legDetails": legs,
            }
            results.append(entry)
            print(f"  ret={row['ret']}% dd={row['dd']}% pf={row['pf']} stars={stars}", flush=True)

    results.sort(key=lambda x: (-x["ret"], x["dd"]))
    report = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "universe": {"bundle": len(rows), "pfGood": len(pf_pool), "strictEligible": strict_n, "hotPfGood": hot_n},
        "filters": {"minPf": MIN_PF, "minEp4": MIN_EP4, "maxDd": MAX_DD},
        "picks": {k: v for k, v in picks.items()},
        "results": results,
    }
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT}", flush=True)


if __name__ == "__main__":
    main()

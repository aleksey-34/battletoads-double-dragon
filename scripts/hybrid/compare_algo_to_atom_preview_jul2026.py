#!/usr/bin/env python3
"""Preview-only: portfolio metrics before/after ZEN/ALGO -> ZEN/ATOM.

Does NOT rematerialize clients or publish cards.
"""
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
OUT = os.environ.get(
    "OUT",
    "/opt/battletoads-double-dragon/results/algo_to_atom_preview_jul2026.json",
)

CARDS = [
    {"key": "safe", "cardId": 72, "systemId": 204, "bars": 9000},
    {"key": "b3", "cardId": 73, "systemId": 205, "bars": 9000},
    {"key": "l400", "cardId": 76, "systemId": 208, "bars": 9000},
    {"key": "turbo", "cardId": 77, "systemId": 209, "bars": 9000},
    {"key": "spot_shield", "cardId": 81, "systemId": 200, "bars": 9000},
    {"key": "spot_balanced", "cardId": 82, "systemId": 201, "bars": 9000},
]


def api_post(path: str, payload: dict, timeout: int = 2400) -> dict:
    last: Exception | None = None
    for attempt in range(50):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last = exc
            print(f"  retry conn/timeout attempt={attempt}: {exc}", flush=True)
            time.sleep(10 + attempt)
            continue
        err = str(data.get("error") or "")
        if data.get("success") is False or (err and "result" not in data and path.endswith("/backtest/run")):
            if "already running" in err.lower() and attempt < 49:
                print(f"  backtest busy, wait… ({attempt})", flush=True)
                time.sleep(12 + attempt)
                continue
            if r.status_code >= 400 and not data.get("result"):
                raise RuntimeError(f"HTTP {r.status_code}: {err or data}")
            if err and not data.get("result"):
                raise RuntimeError(err)
        return data
    raise RuntimeError(f"api_post failed after retries: {last}")


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


def run_portfolio(sids: list[int], lot: float, op: int, reinvest: float, cb: dict, bars: int) -> dict:
    growth = growth_cap(reinvest)
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": bars,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL * growth if growth else 0,
        "lotPercentMultiplierByStrategyId": {str(i): 1.0 for i in sids},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": cb,
    }
    data = api_post("/api/backtest/run", payload)
    return metrics_from(data.get("result") or {})


def run_single(sid: int, bars: int = 5000) -> dict:
    payload = {
        "apiKeyName": API_KEY,
        "mode": "single",
        "strategyId": sid,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": bars,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "lotPercentOverride": 10,
        "reinvestPercentOverride": 0,
        "maxDepositOverride": 0,
        "skipMissingSymbols": True,
    }
    data = api_post("/api/backtest/run", payload)
    return metrics_from(data.get("result") or {})


def clone_pair(conn: sqlite3.Connection, src_id: int, new_quote: str) -> int:
    src = conn.execute("SELECT * FROM strategies WHERE id=?", (src_id,)).fetchone()
    if not src:
        raise SystemExit(f"missing src strategy {src_id}")
    keys = [d[1] for d in conn.execute("PRAGMA table_info(strategies)")]
    row = {k: src[k] for k in keys}
    base = row["base_symbol"]
    interval = row["interval"]
    stype = row["strategy_type"]
    market_type = row.get("market_type") or "futures"
    exist2 = conn.execute(
        """SELECT id FROM strategies
           WHERE api_key_id=? AND base_symbol=? AND quote_symbol=? AND interval=?
             AND strategy_type=? AND market_type=? AND COALESCE(is_archived,0)=0
             AND origin='manual' AND lot_long_percent>=99
           ORDER BY id DESC LIMIT 1""",
        (row["api_key_id"], base, new_quote, interval, stype, market_type),
    ).fetchone()
    if exist2:
        print(f"  reuse existing pair id={exist2[0]} {base}/{new_quote}", flush=True)
        return int(exist2[0])

    name = f"PREVIEW_ALGO2ATOM_{stype}_{base}_{new_quote}_{interval}_{market_type}"
    exist = conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()
    if exist:
        print(f"  reuse clone id={exist[0]} {base}/{new_quote}", flush=True)
        return int(exist[0])

    cols = [k for k in keys if k != "id"]
    vals = []
    for k in cols:
        if k == "name":
            vals.append(name)
        elif k == "quote_symbol":
            vals.append(new_quote)
        elif k in ("is_active", "is_runtime", "is_archived"):
            vals.append(0)
        elif k == "state":
            vals.append("flat")
        elif k in ("created_at", "updated_at"):
            vals.append(datetime.now(timezone.utc).isoformat())
        elif k in ("last_signal", "last_action", "last_error", "published_at", "source_profile_id"):
            vals.append(None)
        else:
            vals.append(row[k])
    placeholders = ",".join(["?"] * len(cols))
    colsql = ",".join(cols)
    conn.execute(f"INSERT INTO strategies ({colsql}) VALUES ({placeholders})", vals)
    conn.commit()
    sid = int(conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()[0])
    print(f"  created clone id={sid} {base}/{new_quote} {interval} {market_type}", flush=True)
    return sid


def card_cfg(conn: sqlite3.Connection, card_id: int) -> dict:
    r = conn.execute("SELECT name, metadata_json FROM master_cards WHERE id=?", (card_id,)).fetchone()
    m = json.loads(r[1] or "{}")
    return {
        "name": r[0],
        "lot": float(m.get("lotPercentOverride") or 15),
        "op": int(m.get("maxOpenPositions") or 8),
        "reinvest": float(m.get("reinvestPercentOverride") or 50),
        "cb": m.get("portfolioCircuitBreaker") or {
            "enabled": True,
            "peakWindowDays": 30,
            "ddTriggerPercent": 8,
            "lotMultiplier": 0.5,
            "pauseDays": 14,
        },
    }


def member_ids(conn: sqlite3.Connection, system_id: int) -> list[dict]:
    rows = conn.execute(
        """SELECT s.id, s.name, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type, s.market_type
           FROM trading_system_members m
           JOIN strategies s ON s.id=m.strategy_id
           WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1
           ORDER BY s.id""",
        (system_id,),
    ).fetchall()
    return [
        {
            "id": int(r[0]),
            "name": r[1],
            "base": r[2],
            "quote": r[3],
            "interval": r[4],
            "stype": r[5],
            "market_type": r[6],
        }
        for r in rows
    ]


def main() -> None:
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row
    print(f"DATE {DATE_FROM} → {DATE_TO}", flush=True)

    fut_atom = clone_pair(conn, 254536, "ATOMUSDT")
    spot_atom = clone_pair(conn, 254905, "ATOMUSDT")

    print("\n=== single-leg ZZ_Fast 4h ===", flush=True)
    leg_algo = run_single(254536)
    print("  ZEN/ALGO", leg_algo, flush=True)
    leg_atom = run_single(fut_atom)
    print("  ZEN/ATOM", leg_atom, flush=True)
    spot_algo: dict = {}
    spot_atom_m: dict = {}
    try:
        spot_algo = run_single(254905)
        print("  SPOT ZEN/ALGO", spot_algo, flush=True)
        spot_atom_m = run_single(spot_atom)
        print("  SPOT ZEN/ATOM", spot_atom_m, flush=True)
    except Exception as e:
        spot_algo = {"error": str(e)}
        spot_atom_m = {"error": str(e)}
        print("  spot single FAIL", e, flush=True)

    out: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "note": "preview only — no client rematerialize",
        "single": {
            "futures_zen_algo": {"strategyId": 254536, **leg_algo},
            "futures_zen_atom": {"strategyId": fut_atom, **leg_atom},
            "spot_zen_algo": {"strategyId": 254905, **spot_algo},
            "spot_zen_atom": {"strategyId": spot_atom, **spot_atom_m},
        },
        "cards": {},
    }

    for card in CARDS:
        cfg = card_cfg(conn, card["cardId"])
        members = member_ids(conn, card["systemId"])
        before_ids = [m["id"] for m in members]
        algo_members = [m for m in members if (m["quote"] or "").upper() == "ALGOUSDT"]
        if not algo_members:
            print(f"\nSKIP {card['key']}: no ALGO member", flush=True)
            continue
        after_ids = []
        replaced = []
        for m in members:
            if (m["quote"] or "").upper() == "ALGOUSDT":
                repl = spot_atom if (m.get("market_type") or "").lower() == "spot" else fut_atom
                after_ids.append(repl)
                replaced.append(
                    {
                        "from": m["id"],
                        "to": repl,
                        "pair": f"{m['base']}/{m['quote']}->{m['base']}/ATOMUSDT",
                        "market_type": m.get("market_type"),
                    }
                )
            else:
                after_ids.append(m["id"])

        print(
            f"\n=== {card['key']} ({cfg['name']}) legs={len(before_ids)} "
            f"lot={cfg['lot']} OP={cfg['op']} ri={cfg['reinvest']} ===",
            flush=True,
        )
        print(f"  replace {replaced}", flush=True)
        t0 = time.time()
        before = run_portfolio(
            before_ids, cfg["lot"], cfg["op"], cfg["reinvest"], cfg["cb"], card["bars"]
        )
        print(f"  BEFORE {before} ({time.time() - t0:.0f}s)", flush=True)
        t1 = time.time()
        after = run_portfolio(
            after_ids, cfg["lot"], cfg["op"], cfg["reinvest"], cfg["cb"], card["bars"]
        )
        print(f"  AFTER  {after} ({time.time() - t1:.0f}s)", flush=True)
        delta = {
            "ret": round(after["ret"] - before["ret"], 2),
            "dd": round(after["dd"] - before["dd"], 2),
            "pf": round(after["pf"] - before["pf"], 3),
            "trades": after["trades"] - before["trades"],
            "wr": round(after["wr"] - before["wr"], 1),
            "finalEquity": round(after["finalEquity"] - before["finalEquity"], 2),
        }
        print(f"  DELTA  {delta}", flush=True)
        out["cards"][card["key"]] = {
            "cardId": card["cardId"],
            "systemId": card["systemId"],
            "displayLabel": cfg["name"],
            "lot": cfg["lot"],
            "op": cfg["op"],
            "reinvest": cfg["reinvest"],
            "cb": cfg["cb"],
            "replaced": replaced,
            "before": before,
            "after": after,
            "delta": delta,
        }

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT}", flush=True)

    print("\n| Card | Ret was→now | DD was→now | PF was→now | Trades was→now | ΔRet | ΔDD |")
    print("|---|---|---|---|---|---|---|")
    for _k, v in out["cards"].items():
        b, a, d = v["before"], v["after"], v["delta"]
        print(
            f"| {v['displayLabel']} | {b['ret']}% → {a['ret']}% | {b['dd']}% → {a['dd']}% | "
            f"{b['pf']} → {a['pf']} | {b['trades']} → {a['trades']} | {d['ret']:+} | {d['dd']:+} |"
        )


if __name__ == "__main__":
    main()

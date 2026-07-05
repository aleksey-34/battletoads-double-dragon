#!/usr/bin/env python3
"""Cloud 1.1 (stars_blend) / 1.2 (stars_max) — lower OP, higher lot grid."""
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
BLEND = os.path.join(REPO, "results", "tv_momentum_cloud", "cloud_stars_blend_jul2026.json")
OUT = os.path.join(REPO, "results", "tv_momentum_cloud", "cloud_v11_v12_lot_grid_jul2026.json")

DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("DATE_TO", "2026-07-04")
INITIAL = 10000.0
CB = {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}

# lower OP + higher lot sweeps
RUNS = [
    *[{"cloud": "1.1", "lot": lot, "op": op, "reinvest": 75, "note": "blend"} for lot, op in [
        (75, 48), (85, 40), (95, 36), (110, 32), (125, 28), (140, 24), (160, 20), (180, 18), (200, 16),
    ]],
    *[{"cloud": "1.2", "lot": lot, "op": op, "reinvest": 75, "note": "max stars"} for lot, op in [
        (75, 48), (85, 40), (95, 36), (110, 32), (125, 28), (140, 24), (160, 20), (180, 18), (200, 16),
    ]],
    {"cloud": "1.1", "lot": 200, "op": 12, "reinvest": 75, "note": "blend tight OP"},
    {"cloud": "1.2", "lot": 200, "op": 12, "reinvest": 75, "note": "max tight OP"},
]


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


def run_pick(conn: sqlite3.Connection, legs: list[dict], lot: float, op: int, reinvest: float) -> dict:
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
    blend = json.load(open(BLEND, encoding="utf-8"))
    picks = {"1.1": blend["picks"]["stars_blend"], "1.2": blend["picks"]["stars_max"]}
    conn = sqlite3.connect(DB)
    rows: list[dict] = []
    for spec in RUNS:
        legs = picks[spec["cloud"]]
        label = f"cloud{spec['cloud']}_l{spec['lot']}_op{spec['op']}"
        print(f"=== {label} ===", flush=True)
        try:
            row = run_pick(conn, legs, spec["lot"], spec["op"], spec["reinvest"])
        except Exception as exc:
            print(f"  skip: {exc}", file=sys.stderr, flush=True)
            continue
        entry = {**spec, "label": label, **row}
        rows.append(entry)
        print(f"  ret={row['ret']}% dd={row['dd']}% skipOP={row['skippedOp']}", flush=True)

    for cloud in ("1.1", "1.2"):
        sub = [r for r in rows if r["cloud"] == cloud]
        sub.sort(key=lambda x: (-x["ret"], x["dd"]))
    rows.sort(key=lambda x: (x["cloud"], -x["ret"]))
    report = {"generatedAt": datetime.now(timezone.utc).isoformat(), "rows": rows}
    json.dump(report, open(OUT, "w", encoding="utf-8"), indent=2)
    print(f"wrote {OUT} n={len(rows)}", flush=True)


if __name__ == "__main__":
    main()

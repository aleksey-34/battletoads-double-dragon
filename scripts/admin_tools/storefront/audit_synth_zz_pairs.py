#!/usr/bin/env python3
"""
Audit synth ratio pairs: Donchian (zz_breakout) vs ZZ_Fast / ZZ_Instance on 1d.

Lot 100%, reinvest 100%, full deposit — honest sizing.
Ranks by DD <= 30% first, then ret and trades.

  python3 scripts/admin_tools/storefront/audit_synth_zz_pairs.py
  AUDIT_PAIRS="LINKUSDT/AIXBTUSDT" AUDIT_LENGTHS="2,3,5" python3 ...
"""
from __future__ import annotations

import json
import os
import sqlite3
import sys
import time
from datetime import datetime, timezone
from typing import Any

import requests

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
sys.path.insert(0, os.path.join(os.path.dirname(__file__)))
from synth_sweep_common import USER_SYNTH_PAIRS  # noqa: E402

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO_ROOT, "backend", "database.db"))
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}

API_KEY = os.environ.get("AUDIT_API_KEY", "BTDD_D1")
INTERVAL = os.environ.get("AUDIT_INTERVAL", "1d")
DATE_FROM = os.environ.get("AUDIT_DATE_FROM", "2024-06-01T00:00:00Z")
DATE_TO = os.environ.get("AUDIT_DATE_TO", "")
INITIAL_BALANCE = float(os.environ.get("AUDIT_INITIAL_BALANCE", "10000"))
LOT_PERCENT = float(os.environ.get("AUDIT_LOT_PERCENT", "100"))
REINVEST = float(os.environ.get("AUDIT_REINVEST_PERCENT", "100"))
MAX_DD_TARGET = float(os.environ.get("AUDIT_MAX_DD", "30"))
PREFIX = os.environ.get("AUDIT_STRATEGY_PREFIX", "AUDIT_ZZ_20260602")

STRATEGY_MATRIX: list[tuple[str, float, str]] = [
    ("zz_breakout", 7.5, "donchian_tp75"),
    ("zz_breakout", 0, "donchian_notp"),
    ("ZZ_Fast", 0, "zz_fast_sar"),
    ("ZZ_Instance", 0, "zz_instance_sar"),
]


def parse_pairs() -> list[str]:
    raw = os.environ.get("AUDIT_PAIRS", "").strip()
    if raw:
        return [p.strip().upper().replace("_", "/") for p in raw.split(",") if p.strip()]
    return list(USER_SYNTH_PAIRS)


def parse_lengths() -> list[int]:
    raw = os.environ.get("AUDIT_LENGTHS", "2,3,5").strip()
    out: list[int] = []
    for token in raw.split(","):
        try:
            val = int(token.strip())
            if val >= 2:
                out.append(val)
        except ValueError:
            continue
    return out or [3]


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    resp = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {resp.status_code}: {resp.text[:600]}")
    return resp.json()


def strategy_name(market: str, stype: str, length: int, label: str) -> str:
    m = market.replace("/", "_")
    return f"{PREFIX}_{label}_{m}_{INTERVAL}_L{length}"


def find_or_create_strategy(
    conn: sqlite3.Connection,
    *,
    market: str,
    base: str,
    quote: str,
    stype: str,
    length: int,
    tp: float,
    label: str,
) -> int:
    name = strategy_name(market, stype, length, label)
    row = conn.execute(
        """
        SELECT s.id FROM strategies s
        JOIN api_keys ak ON ak.id = s.api_key_id
        WHERE ak.name = ? AND s.name = ?
        """,
        (API_KEY, name),
    ).fetchone()
    if row:
        return int(row[0])

    created = api_post(
        f"/api/strategies/{API_KEY}",
        {
            "name": name,
            "strategy_type": stype,
            "market_mode": "synthetic",
            "market_type": "futures",
            "base_symbol": base,
            "quote_symbol": quote,
            "interval": INTERVAL,
            "is_active": False,
            "auto_update": False,
            "display_on_chart": False,
            "long_enabled": True,
            "short_enabled": True,
            "take_profit_percent": tp,
            "price_channel_length": length,
            "detection_source": "wick",
            "lot_long_percent": LOT_PERCENT,
            "lot_short_percent": LOT_PERCENT,
            "max_deposit": 0,
            "reinvest_percent": REINVEST,
            "leverage": 20,
            "margin_type": "cross",
            "fixed_lot": False,
            "zscore_entry": 2,
            "zscore_exit": 0.5,
            "zscore_stop": 3.5,
            "base_coef": 1,
            "quote_coef": 1,
        },
        timeout=120,
    )
    sid = int(created.get("id") or 0)
    if sid <= 0:
        raise RuntimeError(f"Strategy create failed for {name}: {created}")
    return sid


def run_backtest(strategy_id: int, retries: int = 8) -> dict[str, Any]:
    payload = {
        "apiKeyName": API_KEY,
        "mode": "single",
        "strategyId": strategy_id,
        "bars": 1200,
        "warmupBars": 80,
        "skipMissingSymbols": True,
        "initialBalance": INITIAL_BALANCE,
        "lotPercentOverride": LOT_PERCENT,
        "maxDepositOverride": 0,
        "reinvestPercentOverride": REINVEST,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO or None,
        "saveResult": False,
    }
    last_err: Exception | None = None
    for attempt in range(retries):
        try:
            data = api_post("/api/backtest/run", payload, timeout=900)
            result = data.get("result") if isinstance(data.get("result"), dict) else data
            summary = result.get("summary") or result
            return {
                "ret": round(float(summary.get("totalReturnPercent") or 0), 3),
                "dd": round(float(summary.get("maxDrawdownPercent") or 0), 3),
                "pf": round(float(summary.get("profitFactor") or 0), 3),
                "trades": int(summary.get("tradesCount") or 0),
                "wr": round(float(summary.get("winRatePercent") or 0), 2),
            }
        except Exception as exc:
            last_err = exc
            if "429" in str(exc) and attempt + 1 < retries:
                time.sleep(min(30, 3 * (attempt + 1)))
                continue
            raise
    raise last_err or RuntimeError("backtest failed")


def rank_key(row: dict) -> tuple:
    dd = float(row.get("dd") or 99)
    dd_bucket = 0 if dd <= MAX_DD_TARGET else 1
    return (dd_bucket, dd, -float(row.get("ret") or 0), -int(row.get("trades") or 0))


def main() -> None:
    pairs = parse_pairs()
    lengths = parse_lengths()
    print(f"Audit: {len(pairs)} pairs × {len(lengths)} lengths × {len(STRATEGY_MATRIX)} engines @ {INTERVAL}")
    print(f"Lot {LOT_PERCENT}% reinvest {REINVEST}% balance {INITIAL_BALANCE}")

    conn = sqlite3.connect(DB)
    results: list[dict] = []

    for market in pairs:
        parts = market.split("/")
        if len(parts) != 2:
            continue
        base, quote = parts[0].strip().upper(), parts[1].strip().upper()
        for length in lengths:
            for stype, tp, label in STRATEGY_MATRIX:
                try:
                    sid = find_or_create_strategy(
                        conn,
                        market=market,
                        base=base,
                        quote=quote,
                        stype=stype,
                        length=length,
                        tp=tp,
                        label=label,
                    )
                    metrics = run_backtest(sid)
                    row = {
                        "market": market,
                        "length": length,
                        "strategyType": stype,
                        "label": label,
                        "strategyId": sid,
                        **metrics,
                    }
                    results.append(row)
                    flag = "✓" if row["dd"] <= MAX_DD_TARGET else "!"
                    print(
                        f"  {flag} {market} L{length} {label}: "
                        f"ret {row['ret']}% dd {row['dd']}% tr {row['trades']} pf {row['pf']}",
                        flush=True,
                    )
                    time.sleep(0.2)
                except Exception as exc:
                    print(f"  FAIL {market} L{length} {label}: {exc}", flush=True)

    conn.close()
    results.sort(key=rank_key)

    out_dir = os.path.join(REPO_ROOT, "results")
    os.makedirs(out_dir, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%S")
    out_path = os.path.join(out_dir, f"audit_synth_zz_{stamp}.json")
    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "apiKey": API_KEY,
        "interval": INTERVAL,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO or None,
        "lotPercent": LOT_PERCENT,
        "reinvestPercent": REINVEST,
        "maxDdTarget": MAX_DD_TARGET,
        "results": results,
        "topWithinDd": [r for r in results if r.get("dd", 99) <= MAX_DD_TARGET][:20],
    }
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(doc, f, ensure_ascii=False, indent=2)

    print(f"\nSaved {out_path}")
    print("\nTop (DD <= 30%):")
    for row in doc["topWithinDd"][:12]:
        print(
            f"  {row['market']} L{row['length']} {row['label']}: "
            f"ret {row['ret']}% dd {row['dd']}% trades {row['trades']}",
        )


if __name__ == "__main__":
    main()

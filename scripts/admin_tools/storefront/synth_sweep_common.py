"""Shared helpers for synthetic decorrelation sweeps and TS cards."""
from __future__ import annotations

import json
import os
import sqlite3

REPO_ROOT = os.environ.get(
    "BTDD_REPO",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")),
)

TOP_DECORR_FALLBACK = [
    "ORDIUSDT/ZECUSDT", "TRUUSDT/GRTUSDT", "IPUSDT/ZECUSDT", "ORDIUSDT/PYTHUSDT",
    "AUCTIONUSDT/MERLUSDT", "BERAUSDT/IPUSDT", "WLDUSDT/NEARUSDT", "NEARUSDT/SEIUSDT",
    "JUPUSDT/WLDUSDT", "INJUSDT/GRTUSDT", "LTCUSDT/BCHUSDT", "ONDOUSDT/TIAUSDT",
    "STXUSDT/IMXUSDT", "ENAUSDT/SUIUSDT",
]

DEFAULT_FAN_KEYS = [
    "BTDD_D1", "BTDD_D1_OP3_SOURCE", "HDB_17", "HDB_15", "HDB_18", "Mehmet_Bingx",
]

PREFERRED_EXCHANGES = ("bybit", "bitget", "bingx", "weex", "binance")


def load_decorr_synth_markets(*, cap: int = 14) -> list[str]:
    path = os.environ.get(
        "DECORR_SCORES_JSON",
        os.path.join(REPO_ROOT, "results", "synth_pair_decorrelation_latest.json"),
    )
    markets: list[str] = []
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as f:
            doc = json.load(f)
        for key in ("synthMarketsForSweep", "topMarkets"):
            raw = doc.get(key)
            if isinstance(raw, list) and raw:
                markets = [str(m).strip() for m in raw if str(m).strip()]
                break
    if not markets:
        markets = list(TOP_DECORR_FALLBACK)
    return markets[:cap]


def mono_anchors_from_synth(synth_markets: list[str]) -> list[str]:
    syms: set[str] = set()
    for raw in synth_markets:
        parts = str(raw).upper().replace("_", "/").split("/")
        for p in parts:
            p = p.strip()
            if p:
                syms.add(p)
    return sorted(syms)[:24]


def load_fan_api_key_names(*, limit: int = 8) -> list[str]:
    env = os.environ.get("SWEEP_FAN_KEYS", "").strip()
    if env:
        keys = [k.strip() for k in env.split(",") if k.strip()]
        return keys[:limit]

    db_path = os.environ.get(
        "BTDD_DB_PATH",
        os.path.join(REPO_ROOT, "backend", "database.db"),
    )
    picked: list[str] = []
    seen: set[str] = set()

    def add(name: str) -> None:
        n = str(name or "").strip()
        if not n or n in seen:
            return
        seen.add(n)
        picked.append(n)

    add(os.environ.get("SWEEP_PRIMARY_KEY", "BTDD_D1"))

    if os.path.isfile(db_path):
        try:
            conn = sqlite3.connect(db_path)
            placeholders = ",".join("?" for _ in PREFERRED_EXCHANGES)
            rows = conn.execute(
                f"""
                SELECT name, exchange FROM api_keys
                WHERE lower(exchange) IN ({placeholders})
                ORDER BY
                  CASE lower(exchange)
                    WHEN 'bybit' THEN 1 WHEN 'bitget' THEN 2 WHEN 'bingx' THEN 3
                    WHEN 'weex' THEN 4 WHEN 'binance' THEN 5 ELSE 6
                  END,
                  name
                """,
                PREFERRED_EXCHANGES,
            ).fetchall()
            conn.close()
            per_ex: dict[str, int] = {}
            for name, exchange in rows:
                ex = str(exchange or "").lower()
                if per_ex.get(ex, 0) >= 2:
                    continue
                add(name)
                per_ex[ex] = per_ex.get(ex, 0) + 1
                if len(picked) >= limit:
                    break
        except Exception:
            pass

    if len(picked) < 2:
        for k in DEFAULT_FAN_KEYS:
            add(k)
            if len(picked) >= limit:
                break
    return picked[:limit]


def sweep_turbo_extras() -> dict:
    fan = load_fan_api_key_names()
    concurrency = max(1, min(32, int(os.environ.get("SWEEP_CONCURRENCY", "8"))))
    return {
        "fanApiKeyNames": fan,
        "concurrency": concurrency,
    }


def abort_running_sweep(api_base: str, admin_token: str, reason: str) -> None:
    import json
    from urllib import error, request

    req = request.Request(
        f"{api_base}/api/research/sweeps/full-historical/abort",
        data=json.dumps({"reason": reason}).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {admin_token}",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=30) as resp:
            print("abort:", resp.read().decode("utf-8")[:300])
    except error.HTTPError as exc:
        print("abort:", exc.code, exc.read().decode("utf-8")[:300])
    except Exception as exc:
        print("abort skipped:", exc)

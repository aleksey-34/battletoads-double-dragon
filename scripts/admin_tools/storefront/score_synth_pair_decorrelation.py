#!/usr/bin/env python3
"""
Score synthetic ratio markets for decorrelation / spread volatility (732d window proxy).

Uses BTDD market-data API (1d candles). Output feeds build_synthetic_ts_card.py and sweep starters.

  python3 scripts/admin_tools/storefront/score_synth_pair_decorrelation.py
  python3 scripts/admin_tools/storefront/score_synth_pair_decorrelation.py --markets-file /path/markets.txt
  MARKETS="INJUSDT/GRTUSDT,ORDIUSDT/PYTHUSDT" python3 .../score_synth_pair_decorrelation.py

Writes: results/synth_pair_decorrelation_<ts>.json (and results/synth_pair_decorrelation_latest.json)
"""
from __future__ import annotations

import argparse
import json
import math
import os
import time
from datetime import datetime, timezone
from typing import Any
from urllib.parse import quote

import requests

API = os.environ.get("BTDD_API", "http://localhost:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH}
API_KEY = os.environ.get("DECORR_API_KEY", "BTDD_D1")
INTERVAL = os.environ.get("DECORR_INTERVAL", "4h")
CANDLE_LIMIT = int(os.environ.get("DECORR_LIMIT", "500"))
MIN_BARS = int(os.environ.get("DECORR_MIN_BARS", "100"))
FALLBACK_API_KEYS = [
    k.strip()
    for k in os.environ.get(
        "DECORR_FALLBACK_KEYS",
        "BTDD_D1,BTDD_D1_OP3_SOURCE,HDB_17,HDB_15,HDB_18,Mehmet_Bingx,mustafa,IVAN_WEEX_RESEARCH",
    ).split(",")
    if k.strip()
]
REPO_ROOT = os.environ.get(
    "BTDD_REPO",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")),
)

# Default universe: current sweep + supersweep cross-sector pairs
DEFAULT_MARKETS = [
    "ETHUSDT/BTCUSDT", "SOLUSDT/ETHUSDT", "BNBUSDT/BTCUSDT",
    "SUIUSDT/SEIUSDT", "ARBUSDT/OPUSDT", "TIAUSDT/SEIUSDT",
    "LINKUSDT/UNIUSDT", "INJUSDT/GRTUSDT", "FETUSDT/OPUSDT",
    "ORDIUSDT/PYTHUSDT", "TRUUSDT/GRTUSDT", "IPUSDT/ZECUSDT",
    "BERAUSDT/IPUSDT", "AUCTIONUSDT/MERLUSDT", "ONDOUSDT/TIAUSDT",
    "WLDUSDT/NEARUSDT", "ORDIUSDT/ZECUSDT", "NEARUSDT/SEIUSDT",
    "APTUSDT/TIAUSDT", "AVAXUSDT/LINKUSDT", "DOGEUSDT/SHIBUSDT",
    "WIFUSDT/PEPEUSDT", "RENDERUSDT/FETUSDT", "STXUSDT/IMXUSDT",
    "ENAUSDT/SUIUSDT", "JUPUSDT/WLDUSDT", "ATOMUSDT/DOTUSDT",
    "LTCUSDT/BCHUSDT",
]


def norm_market(raw: str) -> str | None:
    s = str(raw or "").strip().upper().replace("_", "/")
    if "/" not in s:
        return None
    base, quote = s.split("/", 1)
    base = base.strip()
    quote = quote.strip()
    if not base or not quote:
        return None
    return f"{base}/{quote}"


def parse_candles(payload: Any) -> list[tuple[int, float]]:
    rows = payload if isinstance(payload, list) else (payload.get("candles") if isinstance(payload, dict) else [])
    if not isinstance(rows, list):
        return []
    out: list[tuple[int, float]] = []
    for row in rows:
        if isinstance(row, (list, tuple)) and len(row) >= 5:
            ts, close = int(row[0]), float(row[4])
        elif isinstance(row, dict):
            ts = int(row.get("timeMs") or row.get("time") or 0)
            close = float(row.get("close") or 0)
            if ts < 1e12:
                ts *= 1000
        else:
            continue
        if ts > 0 and close > 0 and math.isfinite(close):
            out.append((ts, close))
    out.sort(key=lambda x: x[0])
    return out


def fetch_closes_one(api_key: str, symbol: str) -> list[tuple[int, float]]:
    url = (
        f"{API}/api/market-data/{quote(api_key, safe='')}"
        f"?symbol={quote(symbol, safe='')}&interval={quote(INTERVAL, safe='')}&limit={CANDLE_LIMIT}"
    )
    resp = requests.get(url, headers=HEADERS, timeout=90)
    if resp.status_code >= 400:
        raise RuntimeError(f"{symbol}@{api_key}: HTTP {resp.status_code}: {resp.text[:200]}")
    payload = resp.json()
    if isinstance(payload, dict) and payload.get("error"):
        raise RuntimeError(f"{symbol}@{api_key}: {payload.get('error')}")
    candles = parse_candles(payload)
    if len(candles) < 10:
        raise RuntimeError(f"{symbol}@{api_key}: too few candles ({len(candles)}) interval={INTERVAL}")
    return candles


def fetch_closes(symbol: str) -> list[tuple[int, float]]:
    keys = [API_KEY, *[k for k in FALLBACK_API_KEYS if k != API_KEY]]
    last_err = ""
    for api_key in keys:
        try:
            return fetch_closes_one(api_key, symbol)
        except Exception as exc:
            last_err = str(exc)
            continue
    raise RuntimeError(last_err or f"{symbol}: no candles from fan keys")


def align_series(
    base: list[tuple[int, float]],
    quote: list[tuple[int, float]],
    *,
    tolerance_ms: int | None = None,
) -> tuple[list[float], list[float], list[float]]:
    if tolerance_ms is None:
        tol_map = {"1d": 18 * 3600 * 1000, "12h": 6 * 3600 * 1000, "4h": 2 * 3600 * 1000}
        tolerance_ms = tol_map.get(INTERVAL.lower(), 3600 * 1000)

    if tolerance_ms <= 0:
        qmap = {ts: c for ts, c in quote}
        b_closes: list[float] = []
        q_closes: list[float] = []
        ratios: list[float] = []
        for ts, bc in base:
            qc = qmap.get(ts)
            if qc is None or qc <= 0 or bc <= 0:
                continue
            b_closes.append(bc)
            q_closes.append(qc)
            ratios.append(bc / qc)
        return b_closes, q_closes, ratios

    quote_sorted = sorted(quote, key=lambda x: x[0])
    q_ts = [t for t, _ in quote_sorted]
    q_cl = [c for _, c in quote_sorted]
    b_closes: list[float] = []
    q_closes: list[float] = []
    ratios: list[float] = []
    j = 0
    for ts, bc in sorted(base, key=lambda x: x[0]):
        if bc <= 0:
            continue
        while j + 1 < len(q_ts) and abs(q_ts[j + 1] - ts) <= abs(q_ts[j] - ts):
            j += 1
        if not q_ts:
            break
        if abs(q_ts[j] - ts) > tolerance_ms:
            continue
        qc = q_cl[j]
        if qc <= 0:
            continue
        b_closes.append(bc)
        q_closes.append(qc)
        ratios.append(bc / qc)
    return b_closes, q_closes, ratios


def fetch_pair_closes(base_sym: str, quote_sym: str) -> tuple[list[tuple[int, float]], list[tuple[int, float]], str]:
    keys = [API_KEY, *[k for k in FALLBACK_API_KEYS if k != API_KEY]]
    last_err = ""
    for api_key in keys:
        try:
            base_c = fetch_closes_one(api_key, base_sym)
            quote_c = fetch_closes_one(api_key, quote_sym)
            _, _, ratios = align_series(base_c, quote_c)
            if len(ratios) >= 10:
                return base_c, quote_c, api_key
            last_err = f"{base_sym}/{quote_sym}@{api_key}: aligned={len(ratios)}"
        except Exception as exc:
            last_err = str(exc)
            continue
    raise RuntimeError(last_err or f"{base_sym}/{quote_sym}: no aligned candles")


def log_returns(prices: list[float]) -> list[float]:
    out: list[float] = []
    for i in range(1, len(prices)):
        if prices[i - 1] <= 0 or prices[i] <= 0:
            continue
        out.append(math.log(prices[i] / prices[i - 1]))
    return out


def pearson(a: list[float], b: list[float]) -> float:
    n = min(len(a), len(b))
    if n < 30:
        return 0.0
    a, b = a[-n:], b[-n:]
    ma = sum(a) / n
    mb = sum(b) / n
    num = sum((a[i] - ma) * (b[i] - mb) for i in range(n))
    da = math.sqrt(sum((a[i] - ma) ** 2 for i in range(n)))
    db = math.sqrt(sum((b[i] - mb) ** 2 for i in range(n)))
    if da == 0 or db == 0:
        return 0.0
    return num / (da * db)


def ratio_vol_and_swing(ratios: list[float]) -> tuple[float, float]:
    if len(ratios) < 30:
        return 0.0, 0.0
    lr = log_returns(ratios)
    if len(lr) < 20:
        return 0.0, 0.0
    mean = sum(lr) / len(lr)
    var = sum((x - mean) ** 2 for x in lr) / len(lr)
    vol = math.sqrt(var) * math.sqrt(365) * 100  # annualized %

    peak = ratios[0]
    max_swing = 0.0
    for r in ratios:
        if r > peak:
            peak = r
        if peak > 0:
            dd = (peak - r) / peak * 100
            max_swing = max(max_swing, dd)
        up = (r / ratios[0] - 1) * 100 if ratios[0] > 0 else 0
        dn = (1 - r / ratios[0]) * 100 if ratios[0] > 0 else 0
        max_swing = max(max_swing, abs(up), abs(dn))
    return vol, max_swing


def opposite_move_fraction(b_lr: list[float], q_lr: list[float]) -> float:
    n = min(len(b_lr), len(q_lr))
    if n < 30:
        return 0.0
    opp = 0
    for i in range(-n, 0):
        if b_lr[i] == 0 or q_lr[i] == 0:
            continue
        if (b_lr[i] > 0) != (q_lr[i] > 0):
            opp += 1
    return opp / n


def composite_rank_key(row: dict) -> tuple:
    """Higher = better for decorrelation TS (low corr, high ratio drama)."""
    corr = abs(float(row.get("legReturnCorr") or 0))
    return (
        -corr,
        float(row.get("ratioVolAnnualPct") or 0),
        float(row.get("ratioMaxSwingPct") or 0),
        float(row.get("oppositeMoveFrac") or 0),
        int(row.get("bars") or 0),
    )


def score_market(market: str) -> dict | None:
    m = norm_market(market)
    if not m:
        return None
    base_sym, quote_sym = m.split("/", 1)
    try:
        base_c, quote_c, used_key = fetch_pair_closes(base_sym, quote_sym)
    except Exception as exc:
        return {"market": m, "error": str(exc)[:200]}

    b, q, ratios = align_series(base_c, quote_c)
    if len(ratios) < MIN_BARS:
        return {
            "market": m,
            "baseSymbol": base_sym,
            "quoteSymbol": quote_sym,
            "error": f"insufficient_aligned_bars={len(ratios)}",
            "bars": len(ratios),
        }

    b_lr = log_returns(b)
    q_lr = log_returns(q)
    leg_corr = pearson(b_lr, q_lr)
    r_vol, r_swing = ratio_vol_and_swing(ratios)
    opp_frac = opposite_move_fraction(b_lr, q_lr)

    # Decorrelation score 0..100 (heuristic for sorting)
    decorr_score = (
        (1 - min(1.0, abs(leg_corr))) * 40
        + min(80.0, r_vol) * 0.35
        + min(60.0, r_swing) * 0.35
        + opp_frac * 20
    )

    return {
        "market": m,
        "baseSymbol": base_sym,
        "quoteSymbol": quote_sym,
        "bars": len(ratios),
        "interval": INTERVAL,
        "apiKeyUsed": used_key,
        "legReturnCorr": round(leg_corr, 4),
        "absLegCorr": round(abs(leg_corr), 4),
        "ratioVolAnnualPct": round(r_vol, 3),
        "ratioMaxSwingPct": round(r_swing, 3),
        "oppositeMoveFrac": round(opp_frac, 4),
        "decorrScore": round(decorr_score, 2),
    }


def load_markets(args: argparse.Namespace) -> list[str]:
    if args.markets_file and os.path.isfile(args.markets_file):
        with open(args.markets_file, encoding="utf-8") as f:
            raw = [ln.strip() for ln in f if ln.strip() and not ln.startswith("#")]
        return [m for m in (norm_market(x) for x in raw) if m]
    env = os.environ.get("MARKETS", "").strip()
    if env:
        return [m for m in (norm_market(x) for x in env.split(",")) if m]
    return [m for m in (norm_market(x) for x in DEFAULT_MARKETS) if m]


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--markets-file", default="", help="One BASE/QUOTE market per line")
    parser.add_argument("--top", type=int, default=int(os.environ.get("DECORR_TOP", "20")))
    parser.add_argument("--max-abs-corr", type=float, default=float(os.environ.get("DECORR_MAX_ABS_CORR", "0.92")))
    args = parser.parse_args()

    markets = load_markets(args)
    print(f"Scoring {len(markets)} synth markets via {API_KEY} {INTERVAL} limit={CANDLE_LIMIT}")

    scored: list[dict] = []
    errors: list[dict] = []
    for i, market in enumerate(markets, 1):
        row = score_market(market)
        if not row:
            continue
        if row.get("error") and "legReturnCorr" not in row:
            errors.append(row)
            print(f"  [{i}/{len(markets)}] {market}: SKIP {row.get('error')}")
            continue
        scored.append(row)
        print(
            f"  [{i}/{len(markets)}] {row['market']}: corr={row['legReturnCorr']:+.3f} "
            f"ratioVol={row['ratioVolAnnualPct']:.1f}% swing={row['ratioMaxSwingPct']:.1f}% "
            f"opp={row['oppositeMoveFrac']*100:.0f}% score={row['decorrScore']:.1f}"
        )
        time.sleep(0.1)

    scored.sort(key=composite_rank_key, reverse=True)
    filtered = [r for r in scored if float(r.get("absLegCorr") or 1) <= args.max_abs_corr]
    top = filtered[: args.top]

    ts = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H-%M-%SZ")
    out_dir = os.path.join(REPO_ROOT, "results")
    os.makedirs(out_dir, exist_ok=True)
    payload = {
        "generatedAt": ts,
        "apiKeyName": API_KEY,
        "interval": INTERVAL,
        "candleLimit": CANDLE_LIMIT,
        "maxAbsCorr": args.max_abs_corr,
        "marketsRequested": len(markets),
        "marketsScored": len(scored),
        "marketsFiltered": len(filtered),
        "topMarkets": [r["market"] for r in top],
        "synthMarketsForSweep": [r["market"] for r in top],
        "ranked": scored,
        "errors": errors,
    }
    path_ts = os.path.join(out_dir, f"synth_pair_decorrelation_{ts}.json")
    path_latest = os.path.join(out_dir, "synth_pair_decorrelation_latest.json")
    for path in (path_ts, path_latest):
        with open(path, "w", encoding="utf-8") as f:
            json.dump(payload, f, indent=2, ensure_ascii=False)

    print(f"\nTop {len(top)} decorrelated pairs (|corr|<={args.max_abs_corr}):")
    for r in top:
        print(
            f"  {r['market']:28} corr={r['legReturnCorr']:+.3f} "
            f"vol={r['ratioVolAnnualPct']:.1f}% swing={r['ratioMaxSwingPct']:.1f}%"
        )
    print(f"\nWritten: {path_latest}")
    print("Sweep markets (copy):")
    print(",".join(r["market"] for r in top[:16]))


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Honest synthetic-only TS card: diversified across stat_arb / DD_BattleToads / zz_breakout,
732d rerun on BTDD_D1, optional maxOpenPositions A/B.

Usage (VPS, API up):
  python3 scripts/admin_tools/storefront/build_synthetic_ts_card.py
  python3 scripts/admin_tools/storefront/build_synthetic_ts_card.py --apply
  python3 scripts/admin_tools/storefront/build_synthetic_ts_card.py --apply --publish

Decorrelation-first pick (default SYNTH_USE_DECORR_SCORE=1):
  python3 scripts/admin_tools/storefront/score_synth_pair_decorrelation.py
  python3 scripts/vps_start_synth_decorrelation_sweep_20260603.py   # after sweep completes
  SWEEP_JSON=results/btdd_d1_historical_sweep_*.json \\
    python3 scripts/admin_tools/storefront/build_synthetic_ts_card.py --apply

Optional: load sweep from disk instead of offer-store catalog:
  SWEEP_JSON=/opt/battletoads-double-dragon/results/btdd_d1_historical_sweep_*.json \\
    python3 scripts/admin_tools/storefront/build_synthetic_ts_card.py
"""
from __future__ import annotations

import argparse
import copy
import glob
import json
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any

import requests

API = os.environ.get("BTDD_API", "http://localhost:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
REPO_ROOT = os.environ.get(
    "BTDD_REPO",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "..")),
)

SET_KEY = os.environ.get("SYNTH_SET_KEY", "synthetic-portfolio-v1")
DISPLAY_LABEL = os.environ.get("SYNTH_DISPLAY_LABEL", "Synthetic TS Portfolio (732d)")
API_KEY = os.environ.get("SYNTH_API_KEY", "BTDD_D1")
DATE_FROM = os.environ.get("SYNTH_DATE_FROM", "2024-06-01")
DATE_TO = os.environ.get("SYNTH_DATE_TO", "2026-06-03")
INITIAL_BALANCE = float(os.environ.get("SYNTH_INITIAL_BALANCE", "10000"))
REINVEST_PERCENT = float(os.environ.get("SYNTH_REINVEST", "0"))
RISK_SCORE = float(os.environ.get("SYNTH_RISK_SCORE", "5"))
LOT_PERCENT = float(os.environ.get("SYNTH_LOT_PERCENT", "10"))
TRADE_FREQ = float(os.environ.get("SYNTH_TRADE_FREQ", "5"))
TARGET_SIZE = int(os.environ.get("SYNTH_TARGET_SIZE", "18"))
MIN_PER_TYPE = int(os.environ.get("SYNTH_MIN_PER_TYPE", "4"))
MIN_PF = float(os.environ.get("SYNTH_MIN_PF", "0.95"))
MIN_TRADES = int(os.environ.get("SYNTH_MIN_TRADES", "10"))
MIN_PICKS = int(os.environ.get("SYNTH_MIN_PICKS", "3"))
REQUIRE_POSITIVE_RET = os.environ.get("SYNTH_REQUIRE_POSITIVE_RET", "1").strip().lower() not in ("0", "false", "no")
USE_DECORR_SCORE = os.environ.get("SYNTH_USE_DECORR_SCORE", "1").strip().lower() not in ("0", "false", "no")
MAX_ABS_LEG_CORR = float(os.environ.get("SYNTH_MAX_ABS_LEG_CORR", "0.92"))
DECORR_SCORES_JSON = os.environ.get("SYNTH_PAIR_SCORES", "").strip()
ALLOWED_INTERVALS = {
    s.strip().lower()
    for s in os.environ.get("SYNTH_INTERVALS", "1h,2h,4h").split(",")
    if s.strip()
}
_TYPES_RAW = os.environ.get("SYNTH_STRATEGY_TYPES", "").strip()
SYNTH_TYPES: tuple[str, ...] = (
    tuple(t.strip().lower() for t in _TYPES_RAW.split(",") if t.strip())
    if _TYPES_RAW
    else ("stat_arb_zscore", "dd_battletoads", "zz_breakout")
)
MIN_PUBLISH_MEMBERS = int(os.environ.get("SYNTH_MIN_PUBLISH", "6"))


def api_post(path: str, payload: dict, timeout: int = 300) -> dict:
    resp = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {resp.status_code}: {resp.text[:500]}")
    return resp.json()


def api_get(path: str, timeout: int = 60) -> dict:
    resp = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {resp.status_code}: {resp.text[:400]}")
    return resp.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    resp = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if resp.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {resp.status_code}: {resp.text[:400]}")
    return resp.json()


def is_mono(row: dict) -> bool:
    return str(row.get("marketMode") or "").lower() == "mono"


def norm_type(row: dict) -> str:
    return str(row.get("strategyType") or "").lower()


def norm_interval(row: dict) -> str:
    return str(row.get("interval") or "").strip().lower()


def offer_id(row: dict) -> str:
    mode = "mono" if is_mono(row) else "synth"
    return f"offer_{mode}_{norm_type(row)}_{int(row.get('strategyId') or 0)}"


def norm_market_key(market: str) -> str:
    s = str(market or "").strip().upper().replace("_", "/")
    return s if "/" in s else s


def load_pair_decorrelation_scores() -> dict[str, dict]:
    path = DECORR_SCORES_JSON
    if not path:
        latest = os.path.join(REPO_ROOT, "results", "synth_pair_decorrelation_latest.json")
        path = latest if os.path.isfile(latest) else ""
    if not path or not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    ranked = doc.get("ranked") if isinstance(doc.get("ranked"), list) else []
    out: dict[str, dict] = {}
    for row in ranked:
        if not isinstance(row, dict):
            continue
        key = norm_market_key(str(row.get("market") or ""))
        if key:
            out[key] = row
    print(f"Decorr scores: {len(out)} markets from {path}")
    return out


def decorr_tuple(market: str, pair_scores: dict[str, dict]) -> tuple:
    ps = pair_scores.get(norm_market_key(market))
    if not ps or ps.get("error"):
        return (-1.0, 0.0, 0.0, 0.0)
    corr = abs(float(ps.get("legReturnCorr") or ps.get("absLegCorr") or 0))
    return (
        -corr,
        float(ps.get("ratioVolAnnualPct") or 0),
        float(ps.get("ratioMaxSwingPct") or 0),
        float(ps.get("oppositeMoveFrac") or 0),
    )


def row_score(row: dict, pair_scores: dict[str, dict] | None = None) -> tuple:
    robust = 1 if row.get("robust") else 0
    ret = float(row.get("totalReturnPercent") or 0)
    pf = float(row.get("profitFactor") or 0)
    trades = int(row.get("tradesCount") or row.get("trades") or 0)
    score = float(row.get("score") or 0)
    dd = float(row.get("maxDrawdownPercent") or 99)
    base = (robust, ret, pf, trades, -dd, score)
    if pair_scores:
        return (*decorr_tuple(str(row.get("market") or ""), pair_scores), *base)
    return base


def market_passes_decorr_filter(market: str, pair_scores: dict[str, dict]) -> bool:
    if not pair_scores:
        return True
    ps = pair_scores.get(norm_market_key(market))
    if not ps:
        return True
    if ps.get("error"):
        return True
    return abs(float(ps.get("legReturnCorr") or ps.get("absLegCorr") or 0)) <= MAX_ABS_LEG_CORR


def is_ratio_synth(row: dict) -> bool:
    if is_mono(row):
        return False
    return "/" in str(row.get("market") or "")


def passes_filters(row: dict) -> bool:
    if not is_ratio_synth(row):
        return False
    sid = int(row.get("strategyId") or 0)
    if sid <= 0:
        return False
    if norm_interval(row) not in ALLOWED_INTERVALS:
        return False
    st = norm_type(row)
    if st not in SYNTH_TYPES:
        return False
    pf = float(row.get("profitFactor") or 0)
    trades = int(row.get("tradesCount") or row.get("trades") or 0)
    if trades < MIN_TRADES:
        return False
    if pf < MIN_PF and not row.get("robust"):
        return False
    if REQUIRE_POSITIVE_RET:
        ret = float(row.get("totalReturnPercent") or 0)
        if ret <= 0 and not row.get("robust"):
            return False
    return True


def best_per_market(rows: list[dict], pair_scores: dict[str, dict] | None = None) -> list[dict]:
    by_market: dict[str, dict] = {}
    for row in rows:
        market = str(row.get("market") or "").strip()
        if not market:
            continue
        prev = by_market.get(market)
        if prev is None or row_score(row, pair_scores) > row_score(prev, pair_scores):
            by_market[market] = row
    return list(by_market.values())


def pick_diversified_synth(
    rows: list[dict],
    *,
    target: int,
    min_per_type: int,
    pair_scores: dict[str, dict] | None = None,
) -> list[dict]:
    def eligible(r: dict) -> bool:
        if not passes_filters(r):
            return False
        if pair_scores and USE_DECORR_SCORE:
            return market_passes_decorr_filter(str(r.get("market") or ""), pair_scores)
        return True

    score_key = lambda r: row_score(r, pair_scores if USE_DECORR_SCORE else None)

    ps = pair_scores if USE_DECORR_SCORE else None
    by_type: dict[str, list[dict]] = {
        t: best_per_market([r for r in rows if eligible(r) and norm_type(r) == t], ps)
        for t in SYNTH_TYPES
    }
    for t in SYNTH_TYPES:
        by_type[t].sort(key=score_key, reverse=True)

    picked: list[dict] = []
    seen_ids: set[int] = set()
    seen_keys: set[tuple[str, str]] = set()

    def try_add(row: dict) -> bool:
        sid = int(row.get("strategyId") or 0)
        market = str(row.get("market") or "").strip()
        st = norm_type(row)
        key = (market, st)
        if sid in seen_ids or key in seen_keys:
            return False
        picked.append(row)
        seen_ids.add(sid)
        seen_keys.add(key)
        return True

    per_type = max(1, min(min_per_type, target // len(SYNTH_TYPES) or 1))
    for st in SYNTH_TYPES:
        n = 0
        for row in by_type[st]:
            if n >= per_type:
                break
            if try_add(row):
                n += 1

    type_idx = 0
    while len(picked) < target:
        st = SYNTH_TYPES[type_idx % len(SYNTH_TYPES)]
        type_idx += 1
        added = False
        for row in by_type[st]:
            if len(picked) >= target:
                break
            if try_add(row):
                added = True
                break
        if not added and type_idx > len(SYNTH_TYPES) * 50:
            break

    return picked[:target]


def load_sweep_rows() -> tuple[list[dict], str]:
    multi = os.environ.get("SWEEP_JSONS", "").strip()
    if multi:
        paths = [p.strip() for p in multi.split(",") if p.strip()]
        by_id: dict[int, dict] = {}
        loaded: list[str] = []
        for sweep_path in paths:
            if not os.path.isfile(sweep_path):
                print(f"WARN: missing sweep file {sweep_path}")
                continue
            with open(sweep_path, encoding="utf-8") as f:
                sweep = json.load(f)
            chunks: list[dict] = []
            for key in ("evaluated", "topAll"):
                rows = sweep.get(key)
                if isinstance(rows, list):
                    chunks.extend(rows)
            top_by_mode = sweep.get("topByMode") or {}
            if isinstance(top_by_mode.get("synth"), list):
                chunks.extend(top_by_mode["synth"])
            for row in chunks:
                sid = int(row.get("strategyId") or 0)
                if sid > 0 and sid not in by_id:
                    by_id[sid] = row
            loaded.append(sweep_path)
        return list(by_id.values()), f"merged:{len(loaded)} files"

    sweep_path = os.environ.get("SWEEP_JSON", "").strip()
    if not sweep_path:
        pattern = os.path.join(REPO_ROOT, "results", "*_historical_sweep_*.json")
        files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
        sweep_path = files[0] if files else ""

    if sweep_path and os.path.isfile(sweep_path):
        with open(sweep_path, encoding="utf-8") as f:
            sweep = json.load(f)
        source = f"disk:{sweep_path}"
    else:
        store = api_get("/api/saas/admin/offer-store")
        catalog = store.get("sweepCatalog") or store.get("latestSweep") or {}
        sweep = catalog if isinstance(catalog, dict) else {}
        source = "offer-store"

    chunks: list[dict] = []
    for key in ("evaluated", "topAll"):
        rows = sweep.get(key)
        if isinstance(rows, list):
            chunks.extend(rows)
    top_by_mode = sweep.get("topByMode") or {}
    if isinstance(top_by_mode.get("synth"), list):
        chunks.extend(top_by_mode["synth"])

    by_id: dict[int, dict] = {}
    for row in chunks:
        sid = int(row.get("strategyId") or 0)
        if sid > 0 and sid not in by_id:
            by_id[sid] = row
    return list(by_id.values()), source


def downsample_equity(raw: list, limit: int = 160) -> list[float]:
    points: list[float] = []
    for item in raw or []:
        if isinstance(item, dict):
            val = item.get("equity", item.get("value"))
        else:
            val = item
        if val is None:
            continue
        try:
            points.append(round(float(val), 2))
        except (TypeError, ValueError):
            continue
    if len(points) <= limit:
        return points
    step = max(1, len(points) // limit)
    sampled = points[::step]
    if sampled[-1] != points[-1]:
        sampled.append(points[-1])
    return sampled[:limit]


def preview_portfolio(offer_ids: list[str], *, max_open_positions: int) -> dict:
    payload: dict[str, Any] = {
        "kind": "algofund-ts",
        "setKey": SET_KEY,
        "offerIds": offer_ids,
        "forceOfferIds": True,
        "apiKeyName": API_KEY,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "initialBalance": INITIAL_BALANCE,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "preferRealBacktest": True,
        "rerunApiKeyName": API_KEY,
        "lotPercentOverride": LOT_PERCENT,
        "backtestBars": int(os.environ.get("SYNTH_BACKTEST_BARS", "8000")),
        "warmupBars": int(os.environ.get("SYNTH_WARMUP_BARS", "200")),
    }
    if max_open_positions > 0:
        payload["maxOpenPositions"] = max_open_positions
    return api_post("/api/saas/admin/sweep-backtest-preview", payload, timeout=600)


def summarize_preview(label: str, data: dict) -> dict:
    preview = data.get("preview") or {}
    summary = preview.get("summary") or data.get("rerun") or {}
    offers = data.get("selectedOffers") or []
    processed = int(summary.get("processedStrategies") or preview.get("processedStrategies") or 0)
    skipped = int(summary.get("skippedStrategies") or preview.get("skippedStrategies") or 0)
    ret = float(summary.get("totalReturnPercent") or 0)
    dd = float(summary.get("maxDrawdownPercent") or 0)
    pf = float(summary.get("profitFactor") or 0)
    trades = int(summary.get("tradesCount") or 0)
    ok = processed == len(offers) and skipped == 0 and len(offers) > 0
    print(
        f"{label}: ret={ret:.2f}% dd={dd:.2f}% pf={pf:.2f} trades={trades} "
        f"offers={len(offers)} ran={processed} skip={skipped} {'OK' if ok else 'WARN'}"
    )
    return {
        "label": label,
        "ret": ret,
        "dd": dd,
        "pf": pf,
        "trades": trades,
        "processed": processed,
        "skipped": skipped,
        "offerCount": len(offers),
        "ok": ok,
        "data": data,
    }


def choose_op_variant(op0: dict, op10: dict) -> tuple[int, dict]:
    """Prefer higher ret when rerun complete; penalize incomplete runs."""
    def rank(row: dict) -> tuple:
        return (
            1 if row.get("ok") else 0,
            float(row.get("ret") or -999),
            -float(row.get("dd") or 999),
            float(row.get("pf") or 0),
        )

    winner = op10 if rank(op10) > rank(op0) else op0
    mop = 10 if winner is op10 else 0
    print(f"OP pick: maxOpenPositions={mop} ({winner['label']})")
    return mop, winner


def build_snapshot(
    *,
    offer_ids: list[str],
    summary: dict,
    preview_data: dict,
    max_open_positions: int,
    system_name: str,
) -> dict:
    preview = preview_data.get("preview") or {}
    period = preview_data.get("period") or {}
    date_from = str(period.get("dateFrom") or DATE_FROM)[:10]
    date_to = str(period.get("dateTo") or DATE_TO)[:10]
    try:
        d1 = datetime.strptime(date_from, "%Y-%m-%d").date()
        d2 = datetime.strptime(date_to, "%Y-%m-%d").date()
        period_days = max(1, (d2 - d1).days)
    except ValueError:
        period_days = 732

    trades = int(summary.get("tradesCount") or 0)
    equity = downsample_equity(preview.get("equity") or [])
    return {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "apiKeyName": API_KEY,
        "systemName": system_name,
        "ret": round(float(summary.get("totalReturnPercent") or 0), 3),
        "pf": round(float(summary.get("profitFactor") or 0), 3),
        "dd": round(float(summary.get("maxDrawdownPercent") or 0), 3),
        "trades": trades,
        "tradesPerDay": round(trades / period_days, 3),
        "periodDays": period_days,
        "finalEquity": round(float(summary.get("finalEquity") or INITIAL_BALANCE), 2),
        "equityPoints": equity,
        "backtestSettings": {
            "initialBalance": INITIAL_BALANCE,
            "riskScore": RISK_SCORE,
            "tradeFrequencyScore": TRADE_FREQ,
            "reinvestPercent": REINVEST_PERCENT,
            "lotPercent": LOT_PERCENT,
            "backtestBars": int(os.environ.get("SYNTH_BACKTEST_BARS", "8000")),
            "warmupBars": int(os.environ.get("SYNTH_WARMUP_BARS", "200")),
            "maxOpenPositions": max_open_positions,
            "dateFrom": date_from,
            "dateTo": date_to,
        },
    }


def enable_storefront_vitrine(system_name: str) -> int:
    if not os.path.isfile(DB_PATH):
        print(f"WARN: DB not found at {DB_PATH}, skip vitrine SQL")
        return 0
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    profiles = cur.execute("SELECT id FROM algofund_profiles").fetchall()
    enabled = 0
    for (profile_id,) in profiles:
        cur.execute(
            """
            INSERT INTO algofund_active_systems
              (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
            VALUES (?, ?, 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (profile_id, system_name) DO UPDATE SET
              is_enabled = 1,
              assigned_by = 'admin',
              updated_at = CURRENT_TIMESTAMP
            """,
            (profile_id, system_name),
        )
        enabled += 1
    conn.commit()
    conn.close()
    return enabled


def publish_card(offer_ids: list[str], store: dict, snapshot: dict, picked_rows: list[dict] | None = None) -> str:
    members = []
    if picked_rows:
        for row, oid in zip(picked_rows, offer_ids):
            sid = int(row.get("strategyId") or 0)
            if sid <= 0:
                continue
            members.append({
                "strategyId": sid,
                "strategyName": str(row.get("strategyName") or oid),
                "strategyType": str(row.get("strategyType") or norm_type(row)),
                "marketMode": "synthetic",
                "market": str(row.get("market") or ""),
                "score": float(row.get("score") or 0),
                "weight": round(1 / max(1, len(offer_ids)), 4),
            })
    if not members:
        offers_by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
        for oid in offer_ids:
            offer = offers_by_id.get(oid) or {}
            strategy_id = int(offer.get("strategyId") or 0)
            if strategy_id <= 0:
                strategy_id = int(oid.rsplit("_", 1)[-1]) if oid.rsplit("_", 1)[-1].isdigit() else 0
            if strategy_id <= 0:
                continue
            members.append({
                "strategyId": strategy_id,
                "strategyName": str(offer.get("titleRu") or oid),
                "strategyType": str(offer.get("strategyType") or norm_type({"strategyType": offer.get("strategyType")})),
                "marketMode": "synthetic",
                "market": str(offer.get("market") or ""),
                "score": float(offer.get("score") or 0),
                "weight": round(1 / max(1, len(offer_ids)), 4),
            })
    if len(members) < MIN_PUBLISH_MEMBERS:
        raise RuntimeError(f"Need >={MIN_PUBLISH_MEMBERS} resolvable draft members, got {len(members)}")

    api_post("/api/saas/admin/curated-draft-members", {"members": members}, timeout=120)
    publish = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": True,
    }, timeout=300)
    system_name = str((publish.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"Publish did not return systemName: {publish}")

    snapshot = dict(snapshot)
    snapshot["systemName"] = system_name
    current_published = list(store.get("algofundPublishedSystemNames") or [])
    next_published = list(dict.fromkeys([system_name, *current_published]))
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": next_published,
    })
    rows = enable_storefront_vitrine(system_name)
    print(f"vitrine enabled for {rows} profiles")
    return system_name


def catalog_path_for_sweep(sweep_path: str) -> str:
    override = os.environ.get("CATALOG_JSON", "").strip()
    if override:
        return override
    base = os.path.basename(sweep_path)
    if "_historical_sweep_" in base:
        return os.path.join(
            os.path.dirname(sweep_path),
            base.replace("_historical_sweep_", "_client_catalog_"),
        )
    pattern = os.path.join(REPO_ROOT, "results", "*_client_catalog_*.json")
    files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
    return files[0] if files else ""


def build_catalog_offer(row: dict, template: dict | None) -> dict:
    mode = "synth"
    st = str(row.get("strategyType") or "DD_BattleToads")
    sid = int(row.get("strategyId") or 0)
    market = str(row.get("market") or "")
    iv = norm_interval(row) or "4h"
    ret = float(row.get("totalReturnPercent") or 0)
    pf = float(row.get("profitFactor") or 0)
    dd = float(row.get("maxDrawdownPercent") or 0)
    wr = float(row.get("winRatePercent") or 0)
    trades = int(row.get("tradesCount") or row.get("trades") or 0)
    score = float(row.get("score") or 0)
    name = str(row.get("strategyName") or f"Strategy {sid}")
    oid = offer_id(row)

    if template:
        offer = copy.deepcopy(template)
        offer["offerId"] = oid
        offer["titleRu"] = f"SYNTH • {st} • {market}"
        offer["strategy"] = {
            **(offer.get("strategy") or {}),
            "id": sid,
            "name": name,
            "type": st,
            "mode": mode,
            "market": market,
            "params": {
                **((offer.get("strategy") or {}).get("params") or {}),
                "interval": iv,
                "length": int(row.get("length") or 24),
                "takeProfitPercent": float(row.get("takeProfitPercent") or 0),
                "detectionSource": str(row.get("detectionSource") or "close"),
                "zscoreEntry": float(row.get("zscoreEntry") or 2),
                "zscoreExit": float(row.get("zscoreExit") or 0.5),
                "zscoreStop": float(row.get("zscoreStop") or 3),
            },
        }
        offer["metrics"] = {
            "ret": ret,
            "pf": pf,
            "dd": dd,
            "wr": wr,
            "trades": trades,
            "score": score,
            "robust": bool(row.get("robust")),
        }
        return offer

    params = {
        "interval": iv,
        "length": int(row.get("length") or 24),
        "takeProfitPercent": float(row.get("takeProfitPercent") or 0),
        "detectionSource": str(row.get("detectionSource") or "close"),
        "zscoreEntry": float(row.get("zscoreEntry") or 2),
        "zscoreExit": float(row.get("zscoreExit") or 0.5),
        "zscoreStop": float(row.get("zscoreStop") or 3),
    }
    preset = {
        "strategyId": sid,
        "strategyName": name,
        "score": round(score, 3),
        "metrics": {"ret": ret, "pf": pf, "dd": dd, "wr": wr, "trades": trades},
        "params": params,
    }
    return {
        "offerId": oid,
        "titleRu": f"SYNTH • {st} • {market}",
        "descriptionRu": "Собрано из sweep для synthetic TS card.",
        "strategy": {"id": sid, "name": name, "type": st, "mode": mode, "market": market, "params": params},
        "metrics": {"ret": ret, "pf": pf, "dd": dd, "wr": wr, "trades": trades, "score": score, "robust": bool(row.get("robust"))},
        "sliderPresets": {"risk": {"medium": preset}, "tradeFrequency": {"medium": preset}},
        "presetMatrix": {"medium": {"medium": preset}},
    }


def sync_catalog_offers(offer_ids: list[str], sweep_path: str, rows: list[dict]) -> None:
    """Fast Python merge into client catalog JSON (no heavy node import)."""
    if os.environ.get("SYNTH_SKIP_CATALOG_SYNC", "").strip().lower() in ("1", "true", "yes"):
        print("SYNTH_SKIP_CATALOG_SYNC=1, skip catalog sync")
        return

    catalog_path = catalog_path_for_sweep(sweep_path)
    if not catalog_path or not os.path.isfile(catalog_path):
        print(f"WARN: catalog not found ({catalog_path}), skip sync")
        return

    with open(catalog_path, encoding="utf-8") as f:
        catalog = json.load(f)
    client = catalog.setdefault("clientCatalog", {})
    synth = list(client.get("synth") or [])
    existing = {str(o.get("offerId") or "") for o in synth}
    missing = [oid for oid in offer_ids if oid not in existing]
    if not missing:
        print(f"Catalog already has all {len(offer_ids)} offers")
        return

    by_id = {int(r.get("strategyId") or 0): r for r in rows if int(r.get("strategyId") or 0) > 0}
    template = synth[0] if synth else None
    added: list[str] = []
    for oid in missing:
        sid = int(oid.rsplit("_", 1)[-1])
        row = by_id.get(sid)
        if not row:
            print(f"WARN: sweep row missing for {oid}")
            continue
        synth.append(build_catalog_offer(row, template))
        existing.add(oid)
        added.append(oid)

    if not added:
        return

    client["synth"] = synth
    counts = catalog.setdefault("counts", {})
    counts["synthCatalog"] = len(synth)
    with open(catalog_path, "w", encoding="utf-8") as f:
        json.dump(catalog, f, indent=2, ensure_ascii=False)
    print(f"Catalog updated: {catalog_path}")
    print(f"Added {len(added)}/{len(missing)}: {', '.join(added)}")


def log_picks(rows: list[dict], pair_scores: dict[str, dict] | None = None) -> None:
    print(f"\nPicked {len(rows)} synthetic offers (quota min {MIN_PER_TYPE}/type):")
    by_type: dict[str, int] = {}
    by_interval: dict[str, int] = {}
    for row in rows:
        st = norm_type(row)
        iv = norm_interval(row)
        by_type[st] = by_type.get(st, 0) + 1
        by_interval[iv] = by_interval.get(iv, 0) + 1
        ps = (pair_scores or {}).get(norm_market_key(str(row.get("market") or "")))
        decorr = ""
        if ps and not ps.get("error"):
            decorr = f" corr={float(ps.get('legReturnCorr') or 0):+.2f} swing={float(ps.get('ratioMaxSwingPct') or 0):.0f}%"
        print(
            f"  #{row.get('strategyId')} {st} {iv} {row.get('market')} "
            f"ret={float(row.get('totalReturnPercent') or 0):.1f}% "
            f"pf={float(row.get('profitFactor') or 0):.2f}{decorr}"
        )
    print(f"  by type: {by_type}")
    print(f"  by interval: {by_interval}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Save snapshot to offer store")
    parser.add_argument("--publish", action="store_true", help="Publish to Algofund vitrine (implies --apply)")
    parser.add_argument("--skip-op-ab", action="store_true", help="Skip maxOpenPositions 0 vs 10 comparison")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    rows, source = load_sweep_rows()
    print(f"Sweep pool: {len(rows)} unique strategies ({source})")
    print(f"Window: {DATE_FROM} .. {DATE_TO}  key={API_KEY}  target={TARGET_SIZE}")
    print(f"Backtest: risk={RISK_SCORE} lot={LOT_PERCENT}% reinvest={REINVEST_PERCENT}% requireRet>0={REQUIRE_POSITIVE_RET}")

    pair_scores = load_pair_decorrelation_scores() if USE_DECORR_SCORE else {}
    if USE_DECORR_SCORE and not pair_scores:
        print("WARN: no decorr scores — run score_synth_pair_decorrelation.py; using sweep metrics only")
    elif pair_scores:
        print(f"Pick order: decorr (|corr|<={MAX_ABS_LEG_CORR}) then sweep ret/pf")

    forced_offer_ids = [
        x.strip() for x in os.environ.get("SYNTH_OFFER_IDS", "").split(",") if x.strip()
    ]
    forced_picks_json = os.environ.get("SYNTH_FORCED_PICKS_JSON", "").strip()
    forced_picks_from_env = []
    if forced_picks_json:
        try:
            forced_picks_from_env = json.loads(forced_picks_json)
        except json.JSONDecodeError:
            print("WARN: invalid SYNTH_FORCED_PICKS_JSON")
    if forced_offer_ids:
        by_id = {int(r.get("strategyId") or 0): r for r in rows if int(r.get("strategyId") or 0) > 0}
        picked = []
        for oid in forced_offer_ids:
            sid = int(oid.rsplit("_", 1)[-1]) if oid.rsplit("_", 1)[-1].isdigit() else 0
            row = by_id.get(sid)
            if not row and forced_picks_from_env:
                row = next((r for r in forced_picks_from_env if int(r.get("strategyId") or 0) == sid), None)
            if row:
                picked.append(row)
            else:
                print(f"WARN: no sweep row for forced offer {oid}")
        if len(picked) < MIN_PICKS:
            raise RuntimeError(f"Forced offers resolved to {len(picked)} rows, need>={MIN_PICKS}")
        offer_ids = [offer_id(r) for r in picked]
        log_picks(picked, pair_scores or None)
    else:
        picked = pick_diversified_synth(
            rows, target=TARGET_SIZE, min_per_type=MIN_PER_TYPE, pair_scores=pair_scores or None,
        )
        if len(picked) < MIN_PICKS and pair_scores and USE_DECORR_SCORE:
            print(f"WARN: only {len(picked)} after decorr filter — retry without SYNTH_MAX_ABS_LEG_CORR or rerun sweep")
        if len(picked) < MIN_PICKS:
            raise RuntimeError(
                f"Only {len(picked)} synth offers after filters — need>={MIN_PICKS}; "
                "run score_synth_pair_decorrelation.py + vps_start_synth_decorrelation_sweep_20260603.py "
                "or relax SYNTH_MIN_PF/SYNTH_REQUIRE_POSITIVE_RET",
            )
        offer_ids = [offer_id(r) for r in picked]
        log_picks(picked, pair_scores or None)

    sweep_path = os.environ.get("SWEEP_JSON", "").strip()
    if not sweep_path:
        pattern = os.path.join(REPO_ROOT, "results", "*_historical_sweep_*.json")
        files = sorted(glob.glob(pattern), key=os.path.getmtime, reverse=True)
        sweep_path = next((f for f in files if "checkpoint" not in f), "")

    if sweep_path and os.path.isfile(sweep_path):
        print("\n=== Sync offers into client catalog ===")
        sync_catalog_offers(offer_ids, sweep_path, rows)

    draft_system = f"ALGOFUND_MASTER::{API_KEY}::{SET_KEY}"
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {
            SET_KEY: {
                "setKey": SET_KEY,
                "displayLabel": DISPLAY_LABEL,
                "offerIds": offer_ids,
                "apiKeyName": API_KEY,
                "systemName": draft_system,
                "backtestSettings": {
                    "initialBalance": INITIAL_BALANCE,
                    "riskScore": RISK_SCORE,
                    "tradeFrequencyScore": TRADE_FREQ,
                    "reinvestPercent": REINVEST_PERCENT,
                    "lotPercent": LOT_PERCENT,
                    "backtestBars": int(os.environ.get("SYNTH_BACKTEST_BARS", "8000")),
                    "warmupBars": int(os.environ.get("SYNTH_WARMUP_BARS", "200")),
                    "dateFrom": DATE_FROM,
                    "dateTo": DATE_TO,
                },
            },
        },
    })

    print("\n=== Portfolio rerun (maxOpenPositions=0) ===")
    op0 = summarize_preview("OP=0", preview_portfolio(offer_ids, max_open_positions=0))

    if args.skip_op_ab:
        chosen_mop, chosen = 0, op0
    else:
        print("\n=== Portfolio rerun (maxOpenPositions=10) ===")
        op10 = summarize_preview("OP=10", preview_portfolio(offer_ids, max_open_positions=10))
        chosen_mop, chosen = choose_op_variant(op0, op10)

    preview_data = chosen["data"]
    summary = (preview_data.get("preview") or {}).get("summary") or {}
    snapshot = build_snapshot(
        offer_ids=offer_ids,
        summary=summary,
        preview_data=preview_data,
        max_open_positions=chosen_mop,
        system_name=draft_system,
    )

    report_path = f"/tmp/{SET_KEY}_{DATE_TO}.json"
    report = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "offerIds": offer_ids,
        "picks": [
            {
                "strategyId": r.get("strategyId"),
                "strategyType": norm_type(r),
                "interval": norm_interval(r),
                "market": r.get("market"),
                "offerId": offer_id(r),
                "sweepRet": r.get("totalReturnPercent"),
                "pf": r.get("profitFactor"),
                "decorr": (pair_scores or {}).get(norm_market_key(str(r.get("market") or ""))),
            }
            for r in picked
        ],
        "maxOpenPositions": chosen_mop,
        "preview": {
            "ret": chosen.get("ret"),
            "dd": chosen.get("dd"),
            "pf": chosen.get("pf"),
            "trades": chosen.get("trades"),
            "ran": chosen.get("processed"),
            "skip": chosen.get("skipped"),
        },
        "opCompare": None if args.skip_op_ab else {"op0": {k: op0[k] for k in ("ret", "dd", "pf", "ok")}, "op10": {k: op10[k] for k in ("ret", "dd", "pf", "ok")}},
    }
    with open(report_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    print(f"\nReport: {report_path}")

    if not args.apply:
        print("\nDry-run done. Re-run with --apply or --publish.")
        return

    api_patch("/api/saas/admin/offer-store", {"tsBacktestSnapshotsPatch": {SET_KEY: snapshot}})
    print(f"Snapshot saved: {SET_KEY} (maxOP={chosen_mop})")

    if args.publish:
        store = api_get("/api/saas/admin/offer-store")
        publish_rows = picked if os.environ.get("SYNTH_PUBLISH_FROM_ROWS", "").strip().lower() in ("1", "true", "yes") else None
        system_name = publish_card(offer_ids, store, snapshot, picked_rows=publish_rows)
        report["publishedSystemName"] = system_name
        with open(report_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        print(f"Published: {system_name}")


if __name__ == "__main__":
    main()

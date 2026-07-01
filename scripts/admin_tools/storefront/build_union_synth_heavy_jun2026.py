#!/usr/bin/env python3
"""
Synth-heavy union card: NEW engines only (CT_Fractal + ZZ + stat_arb + mono CT).
No 42-leg v2 DD/zz_breakout core — that was causing helicopter DD on rerun.

  python3 scripts/admin_tools/storefront/build_union_synth_heavy_jun2026.py --apply --publish
  python3 ... --v3 --apply --publish   # fresh Jul2026 CT#116 + ZZ#115 picks, reinvest 20%
  python3 ... --op-ab
"""
from __future__ import annotations

import argparse
import importlib.util
import json
import os
import re
import sqlite3
import sys
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026")
if not AUTH.lower().startswith("bearer "):
    AUTH = f"Bearer {AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
REPO = os.environ.get("BTDD_REPO", "/opt/battletoads-double-dragon")
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))

SET_KEY = "union-synth-heavy-jun2026"
DISPLAY_LABEL = "Union Synth Heavy (CT/ZZ Jun 2026)"
ENGINE_SET_KEY = "balanced-shield-dca-v2"
ENGINE_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-c66g2i"
DATE_FROM = os.environ.get("UNION_DATE_FROM", "2025-01-01")

LOT_PERCENT = float(os.environ.get("UNION_LOT_PERCENT", "20"))
MAX_OPEN_POSITIONS = int(os.environ.get("UNION_MAX_OP", "10"))
RISK_SCORE = 8.0
TRADE_FREQ = 8.0
REINVEST_PERCENT = float(os.environ.get("UNION_REINVEST", "50"))
RISK_SCALE_MAX = 300.0
INITIAL_BALANCE = 10000.0
DCA_BASE_PCT = 3.0
DCA_MARKETS = ["SUIUSDT", "TRXUSDT"]
DCA_TUNING = {"interval": "1h", "stepPercent": 0.5, "tpPercent": 1.2, "slPercent": 0, "entryFilter": "always", "perLegSl": False}
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

# Curated from Jun sweeps + decorr pairs (sweep strategyId -> offer suffix type)
CURATED = [
    # CT synth 1d
    ("synth", "ct_fractal", 239404, "ORDIUSDT/ZECUSDT"),
    ("synth", "ct_fractal", 239554, "NEARUSDT/SEIUSDT"),
    ("synth", "ct_fractal", 240118, "SOLUSDT/AVAXUSDT"),
    ("synth", "ct_fractal", 240226, "STXUSDT/IMXUSDT"),
    # ZZ synth 1d
    ("synth", "zz_fast", 240814, "ARBUSDT/OPUSDT"),
    ("synth", "zz_fast", 241016, "IPUSDT/ZECUSDT"),
    ("synth", "zz_instance", 241108, "ARBUSDT/OPUSDT"),
    # stat_arb synth (DB ids)
    ("synth", "stat_arb_zscore", 220053, "BERAUSDT/IPUSDT"),
    ("synth", "stat_arb_zscore", 218804, "ORDIUSDT/PYTHUSDT"),
    ("synth", "stat_arb_zscore", 220089, "AUCTIONUSDT/MERLUSDT"),
    ("synth", "stat_arb_zscore", 219954, "TIAUSDT/SEIUSDT"),
    # mono CT
    ("mono", "ct_fractal", 239677, "JUPUSDT"),
    ("mono", "ct_fractal", 239619, "BERAUSDT"),
    ("mono", "ct_fractal", 239778, "ONDOUSDT"),
]

# Jul 2026 fresh sweeps: CT job #116 + ZZ job #115 (+ stat_arb anchor)
JUL2026_SWEEP_FILES = [
    "btdd_d1_historical_sweep_2026-07-01T20-53-15-730Z.json",
    "btdd_d1_historical_sweep_2026-07-01T20-46-18-697Z.json",
    "btdd_d1_historical_sweep_2026-07-01T17-11-55-932Z.json",
    "btdd_d1_historical_sweep_2026-07-01T16-19-01-575Z.json",
    "btdd_d1_historical_sweep_2026-06-16T10-43-14-084Z.json",
]
JUL2026_CT_CATALOG = "btdd_d1_client_catalog_2026-07-01T17-11-55-932Z.json"
STAT_ARB_CURATED = [
    ("synth", "stat_arb_zscore", 220053, "BERAUSDT/IPUSDT"),
    ("synth", "stat_arb_zscore", 218804, "ORDIUSDT/PYTHUSDT"),
    ("synth", "stat_arb_zscore", 220089, "AUCTIONUSDT/MERLUSDT"),
    ("synth", "stat_arb_zscore", 219954, "TIAUSDT/SEIUSDT"),
]
CT_SYNTH_MARKETS_V3 = [
    "ORDIUSDT/ZECUSDT",
    "NEARUSDT/SEIUSDT",
    "SOLUSDT/AVAXUSDT",
    "ATOMUSDT/DOTUSDT",
]
ZZ_PICKS_V3 = [
    ("zz_fast", "ARBUSDT/OPUSDT"),
    ("zz_instance", "ARBUSDT/OPUSDT"),
    ("zz_fast", "IPUSDT/ZECUSDT"),
]
MONO_CT_MARKETS_V3 = ["JUPUSDT", "BERAUSDT", "BNBUSDT"]


def db_strategy_type(stype: str) -> str:
    if stype == "ct_fractal":
        return "CT_Fractal"
    if stype == "zz_fast":
        return "ZZ_Fast"
    if stype == "zz_instance":
        return "ZZ_Instance"
    if stype == "stat_arb_zscore":
        return "stat_arb_zscore"
    return stype.replace("_", " ").title()


def row_rank(row: dict) -> tuple:
    return (
        1 if row.get("robust") else 0,
        -float(row.get("maxDrawdownPercent") or 99),
        float(row.get("totalReturnPercent") or 0),
    )


def load_sweep_file(fname: str) -> list[dict]:
    path = os.path.join(REPO, "results", fname)
    if not os.path.isfile(path):
        print(f"WARN: missing sweep {path}")
        return []
    with open(path, encoding="utf-8") as f:
        doc = json.load(f)
    return list(doc.get("evaluated") or [])


def merge_jul2026_sweeps() -> str:
    by_sid: dict[int, dict] = {}
    by_key: dict[tuple[str, str, str], dict] = {}
    merged_rows: list[dict] = []
    for fname in JUL2026_SWEEP_FILES:
        for row in load_sweep_file(fname):
            sid = int(row.get("strategyId") or 0)
            key = (
                str(row.get("market") or ""),
                str(row.get("strategyType") or "").lower(),
                str(row.get("marketMode") or "").lower(),
            )
            if sid > 0:
                by_sid[sid] = row
            elif key not in by_key:
                by_key[key] = row
    merged_rows.extend(by_sid.values())
    merged_rows.extend(by_key.values())
    out = os.path.join(REPO, "results", "btdd_d1_historical_sweep_merged_jun2026.json")
    payload = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "config": {
            "interval": "1d",
            "strategyTypes": ["CT_Fractal", "ZZ_Fast", "ZZ_Instance", "stat_arb_zscore"],
            "sources": JUL2026_SWEEP_FILES,
        },
        "evaluated": merged_rows,
        "topByMode": {
            "synth": [r for r in merged_rows if str(r.get("marketMode") or "").lower() in ("synth", "synthetic")][:300],
        },
    }
    with open(out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False)
    print(f"Merged {len(merged_rows)} rows -> {out}")
    return out


def best_sweep_row(
    rows: list[dict],
    *,
    market: str,
    stype: str | None = None,
    mode: str | None = None,
    max_dd: float = 30.0,
) -> dict | None:
    pool = rows
    if market:
        pool = [r for r in pool if str(r.get("market") or "") == market]
    if stype:
        want = db_strategy_type(stype).lower()
        pool = [r for r in pool if str(r.get("strategyType") or "").lower() == want]
    if mode:
        pool = [r for r in pool if str(r.get("marketMode") or "").lower() == mode.lower()]
    pool = [r for r in pool if float(r.get("maxDrawdownPercent") or 99) <= max_dd]
    return max(pool, key=row_rank) if pool else None


def build_fresh_v3_curated(ct_rows: list[dict], zz_rows: list[dict]) -> list[tuple[str, str, int, str, dict | None]]:
    curated: list[tuple[str, str, int, str, dict | None]] = []
    for market in CT_SYNTH_MARKETS_V3:
        row = best_sweep_row(ct_rows, market=market, mode="synth")
        if row:
            curated.append(("synth", "ct_fractal", int(row.get("strategyId") or 0), market, row))
    for stype, market in ZZ_PICKS_V3:
        row = best_sweep_row(zz_rows, market=market, stype=stype, mode="synth")
        if row:
            curated.append(("synth", stype, int(row.get("strategyId") or 0), market, row))
    for mode, stype, sid, market in STAT_ARB_CURATED:
        curated.append((mode, stype, sid, market, None))
    for market in MONO_CT_MARKETS_V3:
        row = best_sweep_row(ct_rows, market=market, mode="mono")
        if row:
            curated.append(("mono", "ct_fractal", int(row.get("strategyId") or 0), market, row))
    return curated


def load_v2():
    path = os.path.join(os.path.dirname(__file__), "build_balanced_shield_dca_v2_synth_card.py")
    spec = importlib.util.spec_from_file_location("v2", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_bst():
    path = os.path.join(os.path.dirname(__file__), "build_synthetic_ts_card.py")
    spec = importlib.util.spec_from_file_location("bst", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def resolve_db_id(conn: sqlite3.Connection, sid: int, stype: str, market: str, mode: str = "synth") -> int:
    row = conn.execute("SELECT id FROM strategies WHERE id=?", (sid,)).fetchone()
    if row:
        return int(row[0])
    base, _, quote = market.partition("/")
    db_type = db_strategy_type(stype)
    if not quote and base:
        if mode == "mono":
            q = conn.execute(
                """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
                   WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=?
                     AND s.strategy_type=? AND COALESCE(s.quote_symbol,'')=''
                   ORDER BY s.id DESC LIMIT 1""",
                (base, db_type),
            ).fetchone()
            if q:
                return int(q[0])
        q = conn.execute(
            """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
               WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=? AND s.strategy_type=?
               ORDER BY s.id DESC LIMIT 1""",
            (base, db_type),
        ).fetchone()
        return int(q[0]) if q else sid
    if stype == "stat_arb_zscore":
        q = conn.execute(
            """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
               WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=? AND s.quote_symbol=?
                 AND s.strategy_type='stat_arb_zscore'
               ORDER BY s.id DESC LIMIT 1""",
            (base, quote),
        ).fetchone()
        return int(q[0]) if q else sid
    q = conn.execute(
        """SELECT s.id FROM strategies s JOIN api_keys ak ON ak.id=s.api_key_id
           WHERE ak.name='BTDD_D1' AND s.interval='1d' AND s.base_symbol=? AND s.quote_symbol=?
             AND lower(s.strategy_type) LIKE ?
           ORDER BY s.id DESC LIMIT 1""",
        (base, quote, f"%{stype.split('_')[0]}%"),
    ).fetchone()
    return int(q[0]) if q else sid


def build_legs(curated: list | None = None, merged_rows: list[dict] | None = None) -> tuple[list[str], list[dict]]:
    conn = sqlite3.connect(DB)
    use_curated = curated if curated is not None else [
        (mode, stype, json_sid, market, None) for mode, stype, json_sid, market in CURATED
    ]
    by_id = {int(r.get("strategyId") or 0): r for r in (merged_rows or []) if int(r.get("strategyId") or 0) > 0}
    by_key = {
        (str(r.get("market") or ""), str(r.get("strategyType") or "").lower()): r
        for r in (merged_rows or [])
    }
    offer_ids: list[str] = []
    picks: list[dict] = []
    seen_keys: set[tuple[str, str, str]] = set()

    for item in use_curated:
        if len(item) == 5:
            mode, stype, json_sid, market, sweep_row = item
        else:
            mode, stype, json_sid, market = item
            sweep_row = None
        k = (mode, stype, market)
        if k in seen_keys:
            continue
        db_sid = resolve_db_id(conn, json_sid, stype, market, mode=mode)
        if db_sid <= 0:
            print(f"WARN: unresolved {mode} {stype} {market} json_sid={json_sid}")
            continue
        oid = f"offer_{mode}_{stype}_{db_sid}"
        row = sweep_row or by_id.get(json_sid) or by_id.get(db_sid) or {}
        if not row:
            row = by_key.get((market, db_strategy_type(stype).lower()), {})
        leg = dict(row) if row else {}
        leg.update({
            "strategyId": db_sid,
            "strategyType": db_strategy_type(stype),
            "marketMode": "synthetic" if mode == "synth" else "mono",
            "market": market if "/" in market else market,
            "interval": "1d",
        })
        picks.append(leg)
        offer_ids.append(oid)
        seen_keys.add(k)
        print(
            f"  leg {oid} {leg.get('market')} ret={float(leg.get('totalReturnPercent') or 0):.1f}% "
            f"dd={float(leg.get('maxDrawdownPercent') or 0):.1f}%"
        )
    conn.close()
    if len(offer_ids) < 10:
        raise SystemExit(f"Need >=10 resolved legs for union card, got {len(offer_ids)}")
    return offer_ids, picks


def api_get(path: str, timeout: int = 120) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    r.raise_for_status()
    return r.json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def filter_btdd_d1_runnable(
    offer_ids: list[str],
    picks: list[dict],
    date_to: str,
) -> tuple[list[str], list[dict]]:
    """Keep legs that backtest on BTDD_D1 (sweep fan keys may differ)."""
    remaining = list(zip(offer_ids, picks))
    for _ in range(max(1, len(remaining))):
        strategy_ids = [int(p.get("strategyId") or 0) for _, p in remaining if int(p.get("strategyId") or 0) > 0]
        if not strategy_ids:
            break
        probe = {
            "apiKeyName": "BTDD_D1",
            "mode": "portfolio",
            "strategyIds": strategy_ids,
            "dateFrom": DATE_FROM,
            "dateTo": date_to,
            "bars": 900,
            "warmupBars": 120,
            "initialBalance": INITIAL_BALANCE,
            "commissionPercent": 0.1,
            "slippagePercent": 0.05,
            "skipMissingSymbols": True,
            "lotPercentOverride": LOT_PERCENT,
        }
        try:
            data = api_post("/api/backtest/run", probe, timeout=600)
            if data.get("success"):
                kept_offers = [o for o, _ in remaining]
                kept_picks = [p for _, p in remaining]
                print(f"BTDD_D1 runnable: {len(kept_offers)}/{len(offer_ids)} legs")
                return kept_offers, kept_picks
            err = str(data.get("error") or "backtest failed")
        except RuntimeError as exc:
            err = str(exc)
        skipped = {int(x) for x in re.findall(r"#(\d+)", err)}
        if not skipped:
            raise RuntimeError(err)
        before = len(remaining)
        remaining = [(o, p) for o, p in remaining if int(p.get("strategyId") or 0) not in skipped]
        print(f"  removed {before - len(remaining)} unrunnable legs ({len(remaining)} left)")
        if len(remaining) == before:
            raise RuntimeError(err)
    kept_offers = [o for o, _ in remaining]
    kept_picks = [p for _, p in remaining]
    print(f"BTDD_D1 runnable: {len(kept_offers)}/{len(offer_ids)} legs")
    return kept_offers, kept_picks


def poll_combined() -> dict:
    for _ in range(900):
        st = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if st.get("running"):
            time.sleep(3)
            continue
        if st.get("error"):
            raise RuntimeError(st["error"])
        if st.get("result"):
            return st["result"]
        time.sleep(2)
    raise RuntimeError("combined preview timeout")


def publish_pure_ts_card(
    store: dict,
    offer_ids: list[str],
    weights: dict[str, float],
    api_key: str,
    combined: dict,
    c_sum: dict,
    date_from: str,
    date_to: str,
    v2mod,
) -> str:
    """Publish TS-only union card — no DCA layer."""
    offers_by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
    members = []
    for offer_id in offer_ids:
        offer = offers_by_id.get(offer_id) or {}
        sid = int(offer.get("strategyId") or 0)
        if sid <= 0:
            tail = offer_id.rsplit("_", 1)[-1]
            if tail.isdigit():
                sid = int(tail)
        if sid <= 0:
            raise RuntimeError(f"No strategyId for {offer_id}")
        members.append({
            "strategyId": sid,
            "strategyName": str(offer.get("titleRu") or offer_id),
            "strategyType": str(offer.get("strategyType") or "DD_BattleToads"),
            "marketMode": "synthetic" if "synth" in offer_id or offer.get("mode") == "synth" else "mono",
            "market": str(offer.get("market") or ""),
            "score": float(offer.get("score") or 0),
            "weight": round(weights.get(offer_id, 1 / len(offer_ids)), 6),
        })
    print(f"[publish] curated-draft-members: {len(members)} (pure TS, no DCA)")
    api_post("/api/saas/admin/curated-draft-members", {"members": members}, timeout=120)

    print(f"[publish] /admin/publish setKey={SET_KEY} offers={len(offer_ids)}")
    publish = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": False,
        "propagateToClients": False,
        "cardOverrides": {
            "lotPercentOverride": LOT_PERCENT,
            "maxOpenPositions": MAX_OPEN_POSITIONS,
        },
    }, timeout=300)
    system_name = str((publish.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"Publish failed: {publish}")

    trades = int(c_sum.get("tradesCount") or 0)
    period_days = max(1, (datetime.fromisoformat(date_to).date() - datetime.fromisoformat(date_from).date()).days)
    bt_settings = v2mod.build_backtest_settings(date_from, date_to)
    bt_settings["dcaEnabled"] = False
    bt_settings["dcaMarkets"] = []
    bt_settings["backtestBars"] = 900
    bt_settings["warmupBars"] = 120
    bt_settings["reinvestPercentOverride"] = REINVEST_PERCENT
    bt_settings["enablePairLock"] = True
    snapshot = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "offerWeightsById": weights,
        "apiKeyName": api_key,
        "systemName": system_name,
        "ret": float(c_sum.get("totalReturnPercent") or 0),
        "pf": float(c_sum.get("profitFactor") or 0),
        "dd": float(c_sum.get("maxDrawdownPercent") or 0),
        "trades": trades,
        "finalEquity": float(c_sum.get("finalEquity") or INITIAL_BALANCE),
        "periodDays": period_days,
        "winRate": float(c_sum.get("winRatePercent") or 0),
        "tradesPerDay": round(trades / period_days, 3),
        "equityPoints": v2mod.extract_equity((combined.get("combined") or {}).get("equity")),
        "backtestSettings": bt_settings,
        "dcaLayer": {"markets": [], "dcaEnabled": False, "note": "pure synth TS portfolio"},
    }
    published = list(store.get("algofundPublishedSystemNames") or [])
    print("[publish] patch offer-store snapshot (no DCA apply)")
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    v2mod.SET_KEY = SET_KEY
    v2mod.DISPLAY_LABEL = DISPLAY_LABEL
    v2mod.patch_master_card(system_name)
    n = v2mod.enable_vitrine(system_name)
    print(f"  published: {system_name} ({len(offer_ids)} offers, NO DCA)")
    print(f"  vitrine enabled for {n} profiles")
    return system_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--op-ab", action="store_true")
    parser.add_argument("--v2", action="store_true", help="Publish as union-synth-heavy-jun2026-v2")
    parser.add_argument("--v3", action="store_true", help="Fresh Jul2026 CT+ZZ picks, reinvest 20 pct, OP=8")
    parser.add_argument("--v3b", action="store_true", help="stat_zz_ct_30 grid winner: 20 legs, reinvest 100, OP=12, NO DCA")
    parser.add_argument("--v3c", action="store_true", help="decorr-priority v3c: up to 32 legs, global market dedupe, NO DCA")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    global SET_KEY, DISPLAY_LABEL, REINVEST_PERCENT, MAX_OPEN_POSITIONS, DATE_FROM
    if args.v2:
        SET_KEY = f"{SET_KEY}-v2"
        DISPLAY_LABEL = f"{DISPLAY_LABEL} V2"
    if args.v3:
        SET_KEY = f"{SET_KEY}-v3"
        DISPLAY_LABEL = "Union Synth Heavy V3 (Jul 2026 CT+ZZ)"
        REINVEST_PERCENT = float(os.environ.get("UNION_REINVEST", "20"))
        MAX_OPEN_POSITIONS = int(os.environ.get("UNION_MAX_OP", "8"))
        DATE_FROM = os.environ.get("UNION_DATE_FROM", "2025-01-01")
    if args.v3b:
        SET_KEY = f"{SET_KEY}-v3b"
        DISPLAY_LABEL = "Union Synth Heavy V3B (stat+ZZ+CT pure)"
        REINVEST_PERCENT = float(os.environ.get("UNION_REINVEST", "100"))
        MAX_OPEN_POSITIONS = int(os.environ.get("UNION_MAX_OP", "12"))
        DATE_FROM = os.environ.get("UNION_DATE_FROM", "2024-06-01")
    if args.v3c:
        SET_KEY = f"{SET_KEY}-v3c"
        DISPLAY_LABEL = "Union Synth Heavy V3C (decorr 32-leg pure)"
        REINVEST_PERCENT = float(os.environ.get("UNION_REINVEST", "100"))
        MAX_OPEN_POSITIONS = int(os.environ.get("UNION_MAX_OP", "14"))
        DATE_FROM = os.environ.get("UNION_DATE_FROM", "2024-06-01")

    v2 = load_v2()
    bst = load_bst()
    merged_path = os.path.join(REPO, "results", "btdd_d1_historical_sweep_merged_jun2026.json")
    merged_rows: list[dict] | None = None
    curated = None
    no_dca = False
    grid = None
    if args.v3b or args.v3c:
        spec = importlib.util.spec_from_file_location(
            "grid", os.path.join(os.path.dirname(__file__), "research_union_v3b_grid_jul2026.py"),
        )
        grid = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(grid)
        merged_path = merge_jul2026_sweeps()
        with open(merged_path, encoding="utf-8") as f:
            merged_rows = list(json.load(f).get("evaluated") or [])
        leg_set = grid.build_leg_sets(grid.load_rows())[
            "stat_zz_ct_v3c" if args.v3c else "stat_zz_ct_30"
        ]
        curated = [(mode, st, sid, market, None) for mode, st, sid, market in leg_set]
        os.environ["CATALOG_JSON"] = os.path.join(REPO, "results", JUL2026_CT_CATALOG)
        os.environ["SWEEP_JSONS"] = ",".join(
            os.path.join(REPO, "results", f) for f in JUL2026_SWEEP_FILES if os.path.isfile(os.path.join(REPO, "results", f))
        )
        no_dca = True
    elif args.v3:
        merged_path = merge_jul2026_sweeps()
        with open(merged_path, encoding="utf-8") as f:
            merged_rows = list(json.load(f).get("evaluated") or [])
        ct_rows = load_sweep_file(JUL2026_SWEEP_FILES[0])
        zz_rows = load_sweep_file(JUL2026_SWEEP_FILES[1])
        curated = build_fresh_v3_curated(ct_rows, zz_rows)
        os.environ["CATALOG_JSON"] = os.path.join(REPO, "results", JUL2026_CT_CATALOG)
        os.environ["SWEEP_JSONS"] = ",".join(
            os.path.join(REPO, "results", f) for f in JUL2026_SWEEP_FILES if os.path.isfile(os.path.join(REPO, "results", f))
        )
    date_to = datetime.now(timezone.utc).date().isoformat()
    min_legs = int(os.environ.get("UNION_MIN_LEGS", "10"))

    if args.v3c and grid is not None:
        rows_for_v3c = grid.load_rows()
        max_dd = float(os.environ.get("V3C_MAX_DD", "28"))
        target = int(os.environ.get("V3C_MAX_LEGS", "32"))
        while True:
            leg_set = grid.build_leg_set_v3c(rows_for_v3c, max_legs=target * 2, max_dd=max_dd)
            offer_ids, picks = build_legs(
                [(m, st, sid, mk, None) for m, st, sid, mk in leg_set],
                merged_rows,
            )
            offer_ids, picks = filter_btdd_d1_runnable(offer_ids, picks, date_to)
            if len(offer_ids) >= min_legs or max_dd >= 50:
                break
            max_dd += 7
            print(f"v3c: only {len(offer_ids)} runnable on BTDD_D1, relax max_dd -> {max_dd}")
        offer_ids = offer_ids[:target]
        picks = picks[:target]
    else:
        offer_ids, picks = build_legs(curated, merged_rows)
        if no_dca:
            offer_ids, picks = filter_btdd_d1_runnable(offer_ids, picks, date_to)

    if len(offer_ids) < min_legs:
        raise SystemExit(f"Need >={min_legs} BTDD_D1-runnable legs, got {len(offer_ids)}")

    weights = {oid: round(1 / len(offer_ids), 6) for oid in offer_ids}

    print(f"{DISPLAY_LABEL}: {len(offer_ids)} legs (no v2 42-core)")
    for oid in offer_ids:
        print(f"  {oid}")

    bst.sync_catalog_offers(offer_ids, merged_path, picks)

    def run_honest_ts_preview() -> tuple[dict, dict]:
        """732d portfolio backtest — same engine as research grid / API rerun."""
        strategy_ids = [int(p.get("strategyId") or 0) for p in picks if int(p.get("strategyId") or 0) > 0]
        w = round(1 / max(1, len(strategy_ids)), 6)
        mul = {str(sid): w for sid in strategy_ids}
        growth = min(20.0, 1.0 + (REINVEST_PERCENT / 100.0) * 19.0) if REINVEST_PERCENT > 0 else 0
        payload = {
            "apiKeyName": "BTDD_D1",
            "mode": "portfolio",
            "strategyIds": strategy_ids,
            "dateFrom": DATE_FROM,
            "dateTo": date_to,
            "bars": 900,
            "warmupBars": 120,
            "initialBalance": INITIAL_BALANCE,
            "commissionPercent": 0.1,
            "slippagePercent": 0.05,
            "maxOpenPositions": MAX_OPEN_POSITIONS,
            "lotPercentOverride": LOT_PERCENT,
            "maxDepositOverride": INITIAL_BALANCE * growth if growth else 0,
            "reinvestPercentOverride": REINVEST_PERCENT,
            "lotPercentMultiplierByStrategyId": mul,
            "enablePairLock": True,
            "macroExitOverlay": V2_MACRO,
            "statArbEntryGate": STAT_GATE,
            "skipMissingSymbols": True,
        }
        data = api_post("/api/backtest/run", payload, timeout=900)
        if not data.get("success"):
            raise RuntimeError(data.get("error") or "backtest failed")
        result = data.get("result") or {}
        s = result.get("summary") or {}
        eq = result.get("equityCurve") or []
        combined = {"combined": {"summary": s, "equity": [p.get("equity") for p in eq if isinstance(p, dict)]}}
        return combined, s

    def run_preview(op: int):
        if no_dca:
            global MAX_OPEN_POSITIONS
            saved_op = MAX_OPEN_POSITIONS
            MAX_OPEN_POSITIONS = op
            combined, s = run_honest_ts_preview()
            MAX_OPEN_POSITIONS = saved_op
            return combined, s
        payload = {
            "systemName": ENGINE_SYSTEM,
            "setKey": ENGINE_SET_KEY,
            "apiKeyName": "BTDD_D1",
            "dateFrom": DATE_FROM,
            "dateTo": date_to,
            "initialBalance": INITIAL_BALANCE,
            "riskScore": RISK_SCORE,
            "tradeFrequencyScore": TRADE_FREQ,
            "reinvestPercent": REINVEST_PERCENT,
            "riskScaleMaxPercent": RISK_SCALE_MAX,
            "lotPercentOverride": LOT_PERCENT,
            "maxOpenPositions": op,
            "enablePairLock": True,
            "offerIds": offer_ids,
            "offerWeightsById": weights,
            "enabled": True,
            "markets": DCA_MARKETS,
            "marketTuning": {m: DCA_TUNING for m in DCA_MARKETS},
            "macroExitOverlay": V2_MACRO,
            "macroShield": True,
            "statArbEntryGate": STAT_GATE,
            "dcaBaseAmountMode": "percent",
            "dcaBaseAmountPercent": DCA_BASE_PCT,
            "dcaInterval": DCA_TUNING["interval"],
            "dcaStepPercent": DCA_TUNING["stepPercent"],
            "dcaTpPercent": DCA_TUNING["tpPercent"],
            "dcaMaxOrders": 15,
            "dcaSlPercent": 0,
            "dcaAutotune": False,
        }
        api_post("/api/saas/admin/ts-dca-combined-preview", payload, timeout=60)
        combined = poll_combined()
        s = (combined.get("combined") or {}).get("summary") or {}
        return combined, s

    if args.op_ab:
        best = None
        for op in (8, 10, 12):
            print(f"\n=== OP={op} ===")
            combined, s = run_preview(op)
            ret = float(s.get("totalReturnPercent") or 0)
            dd = float(s.get("maxDrawdownPercent") or 0)
            tr = int(s.get("tradesCount") or 0)
            print(f"  ret={ret:.1f}% dd={dd:.1f}% trades={tr}")
            if best is None or (-dd, ret) > (-float(best[1].get("maxDrawdownPercent") or 0), float(best[1].get("totalReturnPercent") or 0)):
                best = (op, s, combined)
        MAX_OPEN_POSITIONS, c_sum, combined = best[0], best[1], best[2]
        print(f"OP pick: {MAX_OPEN_POSITIONS}")
    else:
        combined, c_sum = run_preview(MAX_OPEN_POSITIONS)
        print(f"COMBINED: ret={float(c_sum.get('totalReturnPercent') or 0):.1f}% dd={float(c_sum.get('maxDrawdownPercent') or 0):.1f}%")

    if not args.apply:
        print("Dry-run done")
        return

    # publish via v2 helper with our constants
    v2.SET_KEY = SET_KEY
    v2.DISPLAY_LABEL = DISPLAY_LABEL
    v2.LOT_PERCENT = LOT_PERCENT
    v2.MAX_OPEN_POSITIONS = MAX_OPEN_POSITIONS
    v2.REINVEST_PERCENT = REINVEST_PERCENT
    v2.RISK_SCORE = RISK_SCORE
    v2.NEW_SYNTH = offer_ids

    # `offer-store` can be large/slow on cold VPS restarts. For publishing we only
    # need offerId→strategyId (+some metadata for curated draft titles).
    try:
        print("Fetch offer-store...")
        store = api_get("/api/saas/admin/offer-store", timeout=25)
        print("Offer-store loaded")
    except Exception as e:
        print(f"Offer-store unavailable ({type(e).__name__}: {str(e)[:120]}), using stub")
        offers_stub = []
        for oid, leg in zip(offer_ids, picks):
            offers_stub.append({
                "offerId": oid,
                "strategyId": int(leg.get("strategyId") or 0),
                "strategyType": str(leg.get("strategyType") or ""),
                "mode": "synth" if "synth" in oid else "mono",
                "market": str(leg.get("market") or ""),
                "titleRu": str(leg.get("market") or oid),
                "score": float(leg.get("score") or 0),
            })
        store = {"offers": offers_stub, "algofundPublishedSystemNames": []}

    if args.publish:
        for attempt in range(3):
            try:
                if no_dca:
                    sn = publish_pure_ts_card(store, offer_ids, weights, "BTDD_D1", combined, c_sum, DATE_FROM, date_to, v2)
                else:
                    sn = v2.publish_new_card(store, offer_ids, weights, "BTDD_D1", combined, c_sum, DATE_FROM, date_to)
                print(f"Published: {sn}")
                break
            except RuntimeError as e:
                if "transaction" in str(e) and attempt < 2:
                    time.sleep(15)
                    continue
                raise
    else:
        api_patch("/api/saas/admin/offer-store", {
            "tsBacktestSnapshotsPatch": {SET_KEY: {
                "setKey": SET_KEY, "displayLabel": DISPLAY_LABEL, "offerIds": offer_ids,
                "ret": float(c_sum.get("totalReturnPercent") or 0),
                "dd": float(c_sum.get("maxDrawdownPercent") or 0),
            }},
        })


if __name__ == "__main__":
    main()

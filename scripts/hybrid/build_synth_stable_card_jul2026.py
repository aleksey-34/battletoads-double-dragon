#!/usr/bin/env python3
"""
Synth Stable Union v2 — post-tune 4h CT + 1d DD trends + 1d CT/stat_arb.

  python3 scripts/hybrid/rank_post_tune_jul2026.py
  python3 scripts/hybrid/build_synth_stable_card_jul2026.py
  BTDD_API=http://127.0.0.1:3001 python3 scripts/hybrid/build_synth_stable_card_jul2026.py --preview --apply --publish
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import subprocess
import sys
from datetime import datetime, timezone

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db.hybrid_slim"))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
POST_TUNE = os.path.join(REPO, "results/hybrid_post_tune_rank_jul2026.json")
STRATEGIES_EXPORT = os.path.join(REPO, "results/synth_stable_strategies_export.json")
HYBRID_4H_MERGE = os.path.join(REPO, "results/hybrid_sweep_SYNTH4H_V2_20260702_merged.json")

CARD_VER = os.environ.get("SYNTH_CARD_VER", "v4").strip().lower()
WF_RANK = os.path.join(REPO, "results/hybrid_walkforward_rank_jul2026.json")

PORTFOLIO_CB = {
    "enabled": True,
    "peakWindowDays": int(os.environ.get("SYNTH_CB_PEAK_DAYS", "30")),
    "ddTriggerPercent": float(os.environ.get("SYNTH_CB_DD", "8")),
    "lotMultiplier": float(os.environ.get("SYNTH_CB_LOT_MULT", "0.5")),
    "pauseDays": int(os.environ.get("SYNTH_CB_PAUSE_DAYS", "14")),
}

V41_ADDONS = [
    {"strategyId": 253635, "market": "CRVUSDT", "tier": "mono_4h_ct", "legLotMult": 0.5},
    {"strategyId": 218660, "market": "DOGEUSDT/SOLUSDT", "tier": "1d_dd_trend", "legLotMult": 0.5},
]

if CARD_VER == "v4.1":
    SET_KEY = "synth-stable-union-v4.1-jul2026"
    DISPLAY_LABEL = "Synth Stable Union v4.1 (WF + CB8 + compensators)"
    CARD_OUT = os.path.join(REPO, "results/synth_stable_union_card_v4.1_jul2026.json")
    W_4H = float(os.environ.get("SYNTH_W_4H", "0.52"))
    W_MONO_4H = float(os.environ.get("SYNTH_W_MONO_4H", "0.08"))
    W_1D_DD = 0.0
    W_1D_CT = float(os.environ.get("SYNTH_W_1D_CT", "0.22"))
    W_1D_SA = float(os.environ.get("SYNTH_W_1D_SA", "0.18"))
    MAX_MONO_4H = int(os.environ.get("SYNTH_MAX_MONO_4H", "2"))
    MAX_4H = int(os.environ.get("SYNTH_MAX_4H_LEGS", "10"))
    MAX_1D_DD = 0
    MAX_1D_CT = int(os.environ.get("SYNTH_MAX_1D_CT", "5"))
    MAX_1D_SA = int(os.environ.get("SYNTH_MAX_1D_SA", "3"))
elif CARD_VER == "v4":
    SET_KEY = "synth-stable-union-v4-jul2026"
    DISPLAY_LABEL = "Synth Stable Union v4 (walk-forward quality)"
    CARD_OUT = os.path.join(REPO, "results/synth_stable_union_card_v4_jul2026.json")
    W_4H = float(os.environ.get("SYNTH_W_4H", "0.52"))
    W_MONO_4H = float(os.environ.get("SYNTH_W_MONO_4H", "0.08"))
    W_1D_DD = 0.0
    W_1D_CT = float(os.environ.get("SYNTH_W_1D_CT", "0.22"))
    W_1D_SA = float(os.environ.get("SYNTH_W_1D_SA", "0.18"))
    MAX_MONO_4H = int(os.environ.get("SYNTH_MAX_MONO_4H", "2"))
    MAX_4H = int(os.environ.get("SYNTH_MAX_4H_LEGS", "10"))
    MAX_1D_DD = 0
    MAX_1D_CT = int(os.environ.get("SYNTH_MAX_1D_CT", "5"))
    MAX_1D_SA = int(os.environ.get("SYNTH_MAX_1D_SA", "3"))
elif CARD_VER == "v3":
    SET_KEY = "synth-stable-union-v3-jul2026"
    DISPLAY_LABEL = "Synth Stable Union v3 (4h synth+mono + 1d post-tune)"
    CARD_OUT = os.path.join(REPO, "results/synth_stable_union_card_v3_jul2026.json")
    W_4H = float(os.environ.get("SYNTH_W_4H", "0.45"))
    W_MONO_4H = float(os.environ.get("SYNTH_W_MONO_4H", "0.10"))
    W_1D_DD = float(os.environ.get("SYNTH_W_1D_DD", "0.13"))
    W_1D_CT = float(os.environ.get("SYNTH_W_1D_CT", "0.14"))
    W_1D_SA = float(os.environ.get("SYNTH_W_1D_SA", "0.18"))
    MAX_MONO_4H = int(os.environ.get("SYNTH_MAX_MONO_4H", "3"))
    MAX_4H = int(os.environ.get("SYNTH_MAX_4H_LEGS", "14"))
    MAX_1D_DD = int(os.environ.get("SYNTH_MAX_1D_DD", "6"))
    MAX_1D_CT = int(os.environ.get("SYNTH_MAX_1D_CT", "5"))
    MAX_1D_SA = int(os.environ.get("SYNTH_MAX_1D_SA", "5"))
else:
    SET_KEY = "synth-stable-union-v2-jul2026"
    DISPLAY_LABEL = "Synth Stable Union v2 (4h CT + 1d post-tune)"
    CARD_OUT = os.path.join(REPO, "results/synth_stable_union_card_jul2026.json")
    W_4H = float(os.environ.get("SYNTH_W_4H", "0.50"))
    W_MONO_4H = 0.0
    W_1D_DD = float(os.environ.get("SYNTH_W_1D_DD", "0.15"))
    W_1D_CT = float(os.environ.get("SYNTH_W_1D_CT", "0.15"))
    W_1D_SA = float(os.environ.get("SYNTH_W_1D_SA", "0.20"))
    MAX_MONO_4H = 0
    MAX_4H = int(os.environ.get("SYNTH_MAX_4H_LEGS", "14"))
    MAX_1D_DD = int(os.environ.get("SYNTH_MAX_1D_DD", "6"))
    MAX_1D_CT = int(os.environ.get("SYNTH_MAX_1D_CT", "5"))
    MAX_1D_SA = int(os.environ.get("SYNTH_MAX_1D_SA", "5"))

if CARD_VER in ("v4", "v4.1"):
    LOT_PERCENT = float(os.environ.get("SYNTH_LOT_PERCENT", "20"))
else:
    LOT_PERCENT = float(os.environ.get("SYNTH_LOT_PERCENT", "25" if CARD_VER != "v2" else "25"))

DATE_FROM = os.environ.get("SYNTH_DATE_FROM", "2024-06-01")
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL_BALANCE = float(os.environ.get("SYNTH_INITIAL", "10000"))
REINVEST_PERCENT = float(os.environ.get("SYNTH_REINVEST", "50"))
MAX_OPEN_POSITIONS = int(os.environ.get("SYNTH_MAX_OP", "12"))
API_KEY = "BTDD_D1"
RISK_SCORE = float(os.environ.get("SYNTH_RISK_SCORE", "4"))
TRADE_FREQ = float(os.environ.get("SYNTH_TRADE_FREQ", "5"))

# Old synth union cards to drop from vitrine when --cleanup-old
REMOVE_VITRINE_SUBSTR = [
    "union-synth-heavy-jun2026",
    "synthetic-hedge-bomb",
    "synth-best-union",
    "mega-synth-1d",
    "synthetic-bomba",
    "synthetic-portfolio-v1",
    "synthetic-super-v1",
    "synthetic-ip-zec",
    "synth-stable-union-v2-jul2026",
    "synth-stable-union-v2-jul2026-m7nwxy",
    "synth-stable-union-v2-jul2026-odhja9",
    "synth-stable-union-v3-jul2026",
    "synth-stable-union-v3-jul2026-ajjftw",
    "synth-stable-union-v4-jul2026",
]
KEEP_VITRINE_SUBSTR = [
    "balanced-shield-dca",
    "balanced-real",
    "balanced-portfolio",
]

# Tier budget — per-version limits set above for v4/v3/v2
def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def api_get(path: str, timeout: int = 120) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def offer_id(m: dict) -> str:
    mode = "mono" if m.get("marketMode") == "mono" else "synth"
    st = str(m.get("strategyType") or "").lower()
    return f"offer_{mode}_{st}_{m['strategyId']}"


def resolve_member_ids(conn: sqlite3.Connection, members: list[dict]) -> int:
    """Map strategyId to VPS DB id by strategy name (slim vs main id drift)."""
    fixed = 0
    for m in members:
        sid = int(m.get("strategyId") or 0)
        name = str(m.get("strategyName") or "")
        if not name:
            continue
        row = conn.execute("SELECT id FROM strategies WHERE name=?", (name,)).fetchone()
        if not row:
            continue
        vps_id = int(row[0])
        if vps_id != sid:
            m["strategyId"] = vps_id
            fixed += 1
    return fixed


def export_strategies(conn: sqlite3.Connection, sids: list[int]) -> list[dict]:
    cols = [r[1] for r in conn.execute("PRAGMA table_info(strategies)").fetchall()]
    rows: list[dict] = []
    for sid in sids:
        row = conn.execute(
            f"SELECT {','.join(cols)} FROM strategies WHERE id=?",
            (sid,),
        ).fetchone()
        if row:
            rows.append(dict(zip(cols, row)))
    return rows


def portfolio_preview(members: list[dict]) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    mul = {str(m["strategyId"]): float(m.get("effectiveMult") or m.get("legLotMult") or 1.0) for m in members}
    growth = min(20.0, 1.0 + (REINVEST_PERCENT / 100.0) * 19.0) if REINVEST_PERCENT > 0 else 0
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
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
        "skipMissingSymbols": True,
    }
    if PORTFOLIO_CB.get("enabled"):
        payload["portfolioCircuitBreaker"] = PORTFOLIO_CB
    data = api_post("/api/backtest/run", payload)
    if not data.get("success"):
        raise RuntimeError(data.get("error") or "backtest failed")
    return data.get("result") or {}


def build_catalog_offer(m: dict) -> dict:
    sid = int(m["strategyId"])
    st = str(m.get("strategyType") or "")
    market = str(m.get("market") or "")
    iv = str(m.get("interval") or "4h")
    oid = offer_id(m)
    ret = float(m.get("tunedRetEst") or m.get("soloRet100") or 0)
    dd = float(m.get("tunedDdEst") or m.get("soloDd100") or 0)
    pf = float(m.get("soloPf") or 1.0)
    trades = int(m.get("soloTrades") or 0)
    name = str(m.get("strategyName") or f"Strategy {sid}")
    preset = {
        "strategyId": sid,
        "strategyName": name,
        "metrics": {"ret": ret, "pf": pf, "dd": dd, "trades": trades},
        "params": {"interval": iv},
    }
    mode = "mono" if m.get("marketMode") == "mono" else "synthetic"
    return {
        "offerId": oid,
        "titleRu": f"SYNTH • {st} • {market} • {iv}",
        "descriptionRu": f"Synth Stable Union {CARD_VER} leg (post-tune hybrid sweep).",
        "strategy": {"id": sid, "name": name, "type": st, "mode": mode, "market": market, "params": {"interval": iv}},
        "metrics": {"ret": ret, "pf": pf, "dd": dd, "trades": trades, "score": ret},
        "sliderPresets": {"risk": {"medium": preset}, "tradeFrequency": {"medium": preset}},
        "presetMatrix": {"medium": {"medium": preset}},
    }


def sync_offers_to_store(members: list[dict], store: dict) -> list[str]:
    offer_ids = [offer_id(m) for m in members]
    offers = list(store.get("offers") or [])
    by_id = {str(o.get("offerId")): o for o in offers}
    patch_offers: list[dict] = []
    for m in members:
        oid = offer_id(m)
        if oid not in by_id:
            patch_offers.append(build_catalog_offer(m))
    if patch_offers:
        api_patch("/api/saas/admin/offer-store", {"offersPatch": patch_offers})
        print(f"synced {len(patch_offers)} new offers into store")
    return offer_ids


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


def normalize_bt_summary(summary: dict, equity_curve: list | None = None) -> dict:
    s = dict(summary or {})
    if not s.get("totalReturnPercent") and s.get("ret") is not None:
        s["totalReturnPercent"] = s["ret"]
    if not s.get("maxDrawdownPercent") and s.get("dd") is not None:
        s["maxDrawdownPercent"] = s["dd"]
    if not s.get("profitFactor") and s.get("pf") is not None:
        s["profitFactor"] = s["pf"]
    if not s.get("tradesCount") and s.get("trades") is not None:
        s["tradesCount"] = s["trades"]
    if equity_curve:
        s["equity"] = equity_curve
    return s


def build_snapshot(
    offer_ids: list[str],
    summary: dict,
    system_name: str,
    equity_curve: list | None = None,
    lot_mults: dict[str, float] | None = None,
) -> dict:
    s = normalize_bt_summary(summary, equity_curve)
    trades = int(s.get("tradesCount") or 0)
    try:
        d1 = datetime.strptime(DATE_FROM[:10], "%Y-%m-%d").date()
        d2 = datetime.strptime(DATE_TO[:10], "%Y-%m-%d").date()
        period_days = max(1, (d2 - d1).days)
    except ValueError:
        period_days = 400
    equity = downsample_equity(s.get("equity") or [])
    return {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "apiKeyName": API_KEY,
        "systemName": system_name,
        "ret": round(float(s.get("totalReturnPercent") or 0), 3),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 3),
        "trades": trades,
        "tradesPerDay": round(trades / period_days, 3),
        "periodDays": period_days,
        "finalEquity": round(float(s.get("finalEquity") or s.get("final_equity") or INITIAL_BALANCE), 2),
        "equityPoints": equity,
        "backtestSettings": {
            "initialBalance": INITIAL_BALANCE,
            "riskScore": RISK_SCORE,
            "tradeFrequencyScore": TRADE_FREQ,
            "reinvestPercent": REINVEST_PERCENT,
            "lotPercent": LOT_PERCENT,
            "lotPercentOverride": LOT_PERCENT,
            "lotPercentMultiplierByStrategyId": lot_mults or {},
            "maxOpenPositions": MAX_OPEN_POSITIONS,
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "enablePairLock": True,
            "portfolioCircuitBreaker": PORTFOLIO_CB if PORTFOLIO_CB.get("enabled") else None,
        },
    }
    if not snapshot["backtestSettings"].get("portfolioCircuitBreaker"):
        snapshot["backtestSettings"].pop("portfolioCircuitBreaker", None)
    return snapshot


def enable_storefront_vitrine(system_name: str) -> int:
    if not os.path.isfile(DB):
        return 0
    conn = sqlite3.connect(DB)
    profiles = conn.execute("SELECT id FROM algofund_profiles").fetchall()
    enabled = 0
    for (profile_id,) in profiles:
        conn.execute(
            """
            INSERT INTO algofund_active_systems
              (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
            VALUES (?, ?, 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (profile_id, system_name) DO UPDATE SET
              is_enabled = 1, assigned_by = 'admin', updated_at = CURRENT_TIMESTAMP
            """,
            (profile_id, system_name),
        )
        enabled += 1
    conn.commit()
    conn.close()
    return enabled


def publish_card(members: list[dict], offer_ids: list[str], snapshot: dict, store: dict) -> str:
    draft_members = [{
        "strategyId": int(m["strategyId"]),
        "strategyName": str(m.get("strategyName") or ""),
        "strategyType": str(m.get("strategyType") or ""),
        "marketMode": str(m.get("marketMode") or "synthetic"),
        "market": str(m.get("market") or ""),
        "score": float(m.get("tunedRetEst") or 0),
        "weight": round(1.0 / max(1, len(members)), 4),
    } for m in members]
    api_post("/api/saas/admin/curated-draft-members", {"members": draft_members}, timeout=120)
    publish = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": True,
    }, timeout=300)
    system_name = str((publish.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"publish failed: {publish}")
    snapshot = dict(snapshot)
    snapshot["systemName"] = system_name
    published = list(store.get("algofundPublishedSystemNames") or [])
    next_published = list(dict.fromkeys([system_name, *published]))
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": next_published,
    })
    # Drop draft snapshot keys without publish suffix (duplicate vitrine cards).
    draft_keys = [f"ALGOFUND_MASTER::{API_KEY}::{SET_KEY}"]
    snap_patch = {k: None for k in draft_keys if k != system_name}
    if snap_patch:
        api_patch("/api/saas/admin/offer-store", {"tsBacktestSnapshotsPatch": snap_patch})
    rows = enable_storefront_vitrine(system_name)
    print(f"vitrine enabled for {rows} profiles → {system_name}")
    return system_name


def cleanup_old_synth_vitrine(*, apply: bool) -> list[str]:
    store = api_get("/api/saas/admin/offer-store")
    published = list(store.get("algofundPublishedSystemNames") or [])
    remove: list[str] = []
    for name in published:
        if SET_KEY in name or name.endswith(f"::{SET_KEY}"):
            continue
        if any(k in name for k in KEEP_VITRINE_SUBSTR):
            continue
        if any(k in name for k in REMOVE_VITRINE_SUBSTR):
            remove.append(name)
    print("cleanup remove:", remove)
    print("cleanup keep:", [n for n in published if n not in remove])
    if not apply or not remove:
        return remove
    conn = sqlite3.connect(DB)
    for name in remove:
        conn.execute(
            "UPDATE algofund_active_systems SET is_enabled=0, updated_at=CURRENT_TIMESTAMP WHERE system_name=?",
            (name,),
        )
    conn.commit()
    conn.close()
    snap_patch: dict = {}
    for key in list((store.get("tsBacktestSnapshots") or {}).keys()):
        if any(k in key for k in REMOVE_VITRINE_SUBSTR):
            snap_patch[key] = None
    next_pub = [n for n in published if n not in remove]
    api_patch("/api/saas/admin/offer-store", {
        "algofundPublishedSystemNames": next_pub,
        "tsBacktestSnapshotsPatch": snap_patch,
    })
    for name in remove:
        try:
            api_post("/api/saas/admin/storefront-system/remove", {
                "systemName": name,
                "dryRun": False,
                "force": True,
                "closePositions": False,
            })
        except Exception as exc:
            print(f"WARN remove {name}: {exc}")
    print("cleanup done")
    return remove


def append_v41_addons(members: list[dict], conn: sqlite3.Connection) -> None:
    """v4.1 compensators: mono CRV + dd_trend DOGE/SOL @ 0.5 mult."""
    existing_ids = {int(m["strategyId"]) for m in members}
    for ad in V41_ADDONS:
        sid = int(ad["strategyId"])
        if sid in existing_ids:
            continue
        meta = load_strategy(conn, sid)
        if meta:
            members.append({
                **meta,
                "market": ad["market"],
                "tier": ad["tier"],
                "legLotMult": ad["legLotMult"],
                "tunedLotPct": 50,
                "tunedRetEst": 0,
                "tunedDdEst": 0,
            })
        else:
            mode = "mono" if "/" not in ad["market"] else "synthetic"
            st = "CT_Fractal" if "CRV" in ad["market"] else "DD_BattleToads"
            members.append({
                "strategyId": sid,
                "strategyName": f"addon_{ad['market']}",
                "strategyType": st,
                "marketMode": mode,
                "market": ad["market"],
                "interval": "4h" if mode == "mono" else "1d",
                "tier": ad["tier"],
                "legLotMult": ad["legLotMult"],
                "tunedLotPct": 50,
            })
        existing_ids.add(sid)


def load_mono_4h_ct_rows() -> list[dict]:
    """Top mono 4h CT from SYNTH4H_V2 merge (CRV, 1000SATS, TIA)."""
    if not os.path.isfile(HYBRID_4H_MERGE):
        return []
    rows = json.load(open(HYBRID_4H_MERGE, encoding="utf-8")).get("evaluated") or []
    MONO_PICK_IDS = {
        "CRVUSDT": 253635,
        "1000SATSUSDT": 252153,
        "TIAUSDT": 253223,
    }
    if CARD_VER in ("v4", "v4.1"):
        MONO_PICK_IDS = {
            "CRVUSDT": 253635,
            "TIAUSDT": 253223,
        }
    by_id: dict[int, dict] = {}
    for r in rows:
        if r.get("strategyType") != "CT_Fractal":
            continue
        if str(r.get("marketMode") or "").lower() != "mono":
            continue
        if str(r.get("interval") or "") != "4h":
            continue
        sid = int(r.get("strategyId") or 0)
        if sid > 0:
            by_id[sid] = r
    out: list[dict] = []
    for sym, sid in MONO_PICK_IDS.items():
        r = by_id.get(sid)
        if not r:
            continue
        if r["maxDrawdownPercent"] > 32 or r.get("profitFactor", 0) < 1.04:
            continue
        out.append({
            "market": sym,
            "strategyId": int(r.get("strategyId") or 0),
            "strategyName": r.get("strategyName"),
            "strategyType": "CT_Fractal",
            "interval": "4h",
            "tier": "mono_4h_ct",
            "soloRet100": round(float(r["totalReturnPercent"]), 1),
            "soloDd100": round(float(r["maxDrawdownPercent"]), 1),
            "soloPf": round(float(r.get("profitFactor") or 0), 2),
            "soloTrades": int(r.get("tradesCount") or 0),
            "tunedLotPct": 100,
            "tunedRetEst": round(float(r["totalReturnPercent"]), 1),
            "tunedDdEst": round(float(r["maxDrawdownPercent"]), 1),
            "legLotMult": 1.0,
        })
    return out[:MAX_MONO_4H]


def pick_mono_tier(rows: list[dict], limit: int, already: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in rows:
        if len(out) >= limit:
            break
        sym = str(r.get("market") or "").upper()
        if any(str(p.get("market") or "").upper() == sym for p in already + out):
            continue
        out.append(r)
    return out


def tier_weights_map() -> dict[str, float]:
    m = {
        "4h_ct": W_4H,
        "1d_dd_trend": W_1D_DD,
        "1d_ct": W_1D_CT,
        "1d_stat_arb": W_1D_SA,
    }
    if W_MONO_4H > 0:
        m["mono_4h_ct"] = W_MONO_4H
    return m


def composition_counts(members: list[dict]) -> dict:
    tw = tier_weights_map()
    return {
        "legsTotal": len(members),
        "4hCt": sum(1 for m in members if m["tier"] == "4h_ct"),
        "mono4hCt": sum(1 for m in members if m["tier"] == "mono_4h_ct"),
        "1dDdTrend": sum(1 for m in members if m["tier"] == "1d_dd_trend"),
        "1dCt": sum(1 for m in members if m["tier"] == "1d_ct"),
        "1dStatArb": sum(1 for m in members if m["tier"] == "1d_stat_arb"),
        "needsLotTune": sum(1 for m in members if m.get("tunedLotPct", 100) < 100),
        "tierWeights": tw,
    }


def symbols_in_market(market: str) -> set[str]:
    return {p.strip().upper() for p in str(market or "").split("/") if p.strip()}


def decorr_ok(market: str, picked: list[dict], max_shared: int = 1) -> bool:
    """Skip if same market pair already picked (any strategy)."""
    m = str(market or "").strip().upper()
    for p in picked:
        if str(p.get("market") or "").strip().upper() == m:
            return False
    syms = symbols_in_market(market)
    for p in picked:
        shared = syms & symbols_in_market(p["market"])
        if len(shared) > max_shared:
            return False
    return True


def pick_tier(rows: list[dict], limit: int, already: list[dict]) -> list[dict]:
    out: list[dict] = []
    for r in rows:
        if len(out) >= limit:
            break
        if not decorr_ok(r["market"], already + out):
            continue
        if any(x["strategyId"] == r["strategyId"] for x in already + out):
            continue
        out.append(r)
    return out


def load_strategy(conn: sqlite3.Connection, sid: int) -> dict | None:
    row = conn.execute(
        """SELECT id, name, strategy_type, market_mode, base_symbol, quote_symbol, interval
           FROM strategies WHERE id=?""",
        (sid,),
    ).fetchone()
    if not row:
        return None
    market = f"{row[4]}/{row[5]}" if row[5] else row[4]
    return {
        "strategyId": int(row[0]),
        "strategyName": row[1],
        "strategyType": row[2],
        "marketMode": "synthetic" if str(row[3]).lower() != "mono" else "mono",
        "market": market,
        "interval": row[6],
    }


def assign_weights(members: list[dict], tier_weights: dict[str, float]) -> None:
    by_tier: dict[str, list[dict]] = {}
    for m in members:
        by_tier.setdefault(m["tier"], []).append(m)
    for tier, group in by_tier.items():
        share = tier_weights.get(tier, 0)
        if share <= 0 or not group:
            continue
        for m in group:
            m["weight"] = round(share / len(group), 6)
            # Post-tune lot only — tier weight is allocation metadata, NOT engine mult.
            # Engine: lot = lotPercentOverride × multiplier. Using weight here crushed exposure ~40×.
            m["effectiveMult"] = round(float(m.get("legLotMult") or 1.0), 4)
    # Legs in tiers with zero share still need metadata for publish/admin.
    for m in members:
        m.setdefault("weight", round(1.0 / max(1, len(members)), 6))
        m.setdefault("effectiveMult", round(float(m.get("legLotMult") or 1.0), 4))


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--preview", action="store_true")
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--publish", action="store_true")
    parser.add_argument("--cleanup-old", action="store_true")
    parser.add_argument("--export-only", action="store_true")
    parser.add_argument("--from-card", default="", help="Use prebuilt card JSON (skip pick from post_tune)")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    if args.from_card:
        card = json.load(open(args.from_card, encoding="utf-8"))
        members = list(card.get("members") or [])
        if len(members) < 8:
            raise SystemExit(f"Card has {len(members)} legs, need >=8")
        out = args.from_card
    else:
        if not os.path.isfile(POST_TUNE):
            subprocess.check_call([sys.executable, os.path.join(REPO, "scripts/hybrid/rank_post_tune_jul2026.py")])

        pt = json.load(open(POST_TUNE, encoding="utf-8"))
        conn = sqlite3.connect(DB)
        members = []
        wf = None

        if CARD_VER in ("v4", "v4.1"):
            if not os.path.isfile(WF_RANK):
                v3_card = os.path.join(REPO, "results/synth_stable_union_card_v3_jul2026.json")
                wf_cmd = [
                    sys.executable,
                    os.path.join(REPO, "scripts/hybrid/rank_walkforward_jul2026.py"),
                    "--max-4h", str(MAX_4H + 4),
                    "--max-1d-ct", str(MAX_1D_CT + 2),
                    "--max-1d-sa", str(MAX_1D_SA + 1),
                ]
                if os.path.isfile(v3_card):
                    wf_cmd.extend(["--from-card", v3_card])
                subprocess.check_call(wf_cmd)
            wf = json.load(open(WF_RANK, encoding="utf-8"))
            tier_rows = [
                ("4h_ct", wf.get("4hCtWalkForward") or [], MAX_4H),
                ("1d_stat_arb", wf.get("1dStatArbWalkForward") or [], MAX_1D_SA),
                ("1d_ct", wf.get("1dCtWalkForward") or [], MAX_1D_CT),
            ]
        else:
            tier_rows = [
                ("4h_ct", pt.get("4hCtPostTune") or [], MAX_4H),
                ("1d_stat_arb", pt.get("1dStatArbPostTune") or [], MAX_1D_SA),
                ("1d_ct", pt.get("1dCtPostTune") or [], MAX_1D_CT),
            ]
            if MAX_1D_DD > 0:
                tier_rows.append(("1d_dd_trend", pt.get("1dDdTrendPostTune") or [], MAX_1D_DD))

        for tier_key, rows, limit in tier_rows:
            normed = []
            for r in rows:
                x = dict(r)
                x["tier"] = tier_key
                normed.append(x)
            picked = pick_tier(normed, limit, members)
            for r in picked:
                meta = load_strategy(conn, int(r["strategyId"]))
                if not meta:
                    print(f"WARN skip {r['strategyId']}", file=sys.stderr)
                    continue
                members.append({**meta, **{k: v for k, v in r.items() if k not in meta}})

        if MAX_MONO_4H > 0:
            mono_rows = load_mono_4h_ct_rows()
            picked_mono = pick_mono_tier(mono_rows, MAX_MONO_4H, members)
            for r in picked_mono:
                meta = load_strategy(conn, int(r["strategyId"]))
                if meta:
                    members.append({**meta, **{k: v for k, v in r.items() if k not in meta}})
                else:
                    members.append({
                        "strategyId": int(r["strategyId"]),
                        "strategyName": r.get("strategyName") or f"mono_{r['market']}",
                        "strategyType": r.get("strategyType") or "CT_Fractal",
                        "marketMode": "mono",
                        "market": r["market"],
                        "interval": r.get("interval") or "4h",
                        **r,
                    })

        if CARD_VER == "v4.1":
            append_v41_addons(members, conn)

        if len(members) < 8:
            raise SystemExit(f"Need >=8 legs, got {len(members)}")

        assign_weights(members, tier_weights_map())

        card = {
            "generatedAt": datetime.now(timezone.utc).isoformat(),
            "setKey": SET_KEY,
            "displayLabel": DISPLAY_LABEL,
            "cardVersion": CARD_VER,
            "apiKeyName": API_KEY,
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "portfolio": {
                "lotPercent": LOT_PERCENT,
                "reinvestPercent": REINVEST_PERCENT,
                "maxOpenPositions": MAX_OPEN_POSITIONS,
                "initialBalance": 10000.0,
                "enablePairLock": True,
            },
            "composition": composition_counts(members),
            "members": members,
            "offerIds": [offer_id(m) for m in members],
            "postTuneNotes": pt.get("notes") or {},
            "walkForward": wf if CARD_VER in ("v4", "v4.1") else None,
            "portfolioCircuitBreaker": PORTFOLIO_CB if PORTFOLIO_CB.get("enabled") else None,
        }
        if card.get("walkForward") is None:
            card.pop("walkForward", None)
        out = CARD_OUT
        json.dump(card, open(out, "w"), indent=2, ensure_ascii=False)

    conn = sqlite3.connect(DB)
    remapped = resolve_member_ids(conn, members)
    if remapped:
        print(f"Remapped {remapped} strategy ids to local DB")
    if not args.from_card:
        sids = [int(m["strategyId"]) for m in members]
        export_rows = export_strategies(conn, sids)
        json.dump(export_rows, open(STRATEGIES_EXPORT, "w"), indent=2, ensure_ascii=False)
        print(f"Exported {len(export_rows)} strategies → {STRATEGIES_EXPORT}")
    print(f"Wrote {out}")
    print(
        f"  legs={len(members)} "
        f"4h={card['composition']['4hCt']} "
        f"mono4h={card['composition'].get('mono4hCt', 0)} "
        f"1dDD={card['composition']['1dDdTrend']} "
        f"1dCT={card['composition']['1dCt']} "
        f"1dSA={card['composition']['1dStatArb']}"
    )
    for m in members:
        print(
            f"  [{m['tier']}] {m['market']:28} id={m['strategyId']} "
            f"tune={m.get('tunedLotPct',100)}% w={m['weight']} "
            f"ret~{m.get('tunedRetEst','?')} dd~{m.get('tunedDdEst','?')}"
        )

    if args.export_only:
        return

    lot_mults = {
        str(m["strategyId"]): float(m.get("effectiveMult") or m.get("legLotMult") or 1.0)
        for m in members
    }

    if args.cleanup_old:
        cleanup_old_synth_vitrine(apply=args.apply)

    card["_backtestResult"] = None

    if args.preview or args.apply:
        try:
            result = portfolio_preview(members)
            s = result.get("summary") or {}
            eq = result.get("equityCurve") or []
            card["portfolioBacktest"] = {
                "ret": round(float(s.get("totalReturnPercent") or 0), 2),
                "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
                "pf": round(float(s.get("profitFactor") or 0), 2),
                "trades": int(s.get("tradesCount") or 0),
                "finalEquity": round(float(s.get("finalEquity") or s.get("final_equity") or INITIAL_BALANCE), 2),
            }
            card["_backtestSummary"] = normalize_bt_summary(s, eq)
            json.dump({k: v for k, v in card.items() if not k.startswith("_")}, open(out, "w"), indent=2, ensure_ascii=False)
            pb = card["portfolioBacktest"]
            print(f"\nPortfolio backtest: ret={pb['ret']}% dd={pb['dd']}% pf={pb['pf']} trades={pb['trades']}")
        except Exception as exc:
            print(f"\nPortfolio backtest failed: {exc}", file=sys.stderr)
            if args.apply:
                raise

    if args.apply:
        store = api_get("/api/saas/admin/offer-store")
        draft_system = f"ALGOFUND_MASTER::{API_KEY}::{SET_KEY}"
        offer_ids = sync_offers_to_store(members, store)
        card["offerIds"] = offer_ids
        summary = card.get("_backtestSummary") or normalize_bt_summary(card.get("portfolioBacktest") or {})
        eq = summary.get("equity")
        snapshot = build_snapshot(offer_ids, summary, draft_system, eq, lot_mults)
        api_patch("/api/saas/admin/offer-store", {"tsBacktestSnapshotsPatch": {SET_KEY: snapshot}})
        json.dump(card, open(out, "w"), indent=2, ensure_ascii=False)
        print(f"Draft snapshot saved setKey={SET_KEY}")

    if args.publish:
        store = api_get("/api/saas/admin/offer-store")
        offer_ids = card.get("offerIds") or [offer_id(m) for m in members]
        summary = card.get("_backtestSummary") or normalize_bt_summary(card.get("portfolioBacktest") or {})
        snapshot = build_snapshot(
            offer_ids, summary, f"ALGOFUND_MASTER::{API_KEY}::{SET_KEY}",
            summary.get("equity"), lot_mults,
        )
        system_name = publish_card(members, offer_ids, snapshot, store)
        card["publishedSystemName"] = system_name
        json.dump(card, open(out, "w"), indent=2, ensure_ascii=False)
        print(f"PUBLISHED {system_name}")


if __name__ == "__main__":
    main()

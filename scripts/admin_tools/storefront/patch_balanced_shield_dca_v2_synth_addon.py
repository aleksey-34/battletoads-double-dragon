#!/usr/bin/env python3
"""
Patch Balanced Shield + DCA v2 card: add 4 decorr synth offers + OP=20 + pairLock.

  python3 scripts/admin_tools/storefront/patch_balanced_shield_dca_v2_synth_addon.py
  python3 scripts/admin_tools/storefront/patch_balanced_shield_dca_v2_synth_addon.py --apply --publish
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
_RAW_AUTH = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = _RAW_AUTH if _RAW_AUTH.lower().startswith("bearer ") else f"Bearer {_RAW_AUTH}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB_PATH = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")

SET_KEY = "balanced-shield-dca-v2"
DISPLAY_LABEL = "Balanced Shield + DCA v2"
DEFAULT_SYSTEM_NAME = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-x4wc64"

V2_SNAP_KEYS = (
    SET_KEY,
    f"{SET_KEY}-x4wc64",
    DEFAULT_SYSTEM_NAME,
)

SYNTH_OFFER_IDS = [
    "offer_synth_dd_battletoads_221785",
    "offer_synth_dd_battletoads_221782",
    "offer_synth_zz_breakout_221787",
    "offer_synth_zz_breakout_221784",
]
SYNTH_STRATEGY_IDS = [221785, 221782, 221787, 221784]
SYNTH_WEIGHT_EACH = 0.01  # ~4% total synth slice

MAX_OPEN_POSITIONS = int(os.environ.get("SHIELD_MAX_OP", "20"))
LOT_PERCENT = float(os.environ.get("SHIELD_LOT_PERCENT", "20"))
REINVEST_PERCENT = float(os.environ.get("SHIELD_REINVEST", "100"))
RISK_SCORE = float(os.environ.get("SHIELD_RISK_SCORE", "10"))
TRADE_FREQ = float(os.environ.get("SHIELD_TRADE_FREQ", "8"))
RISK_SCALE_MAX = float(os.environ.get("SHIELD_RISK_SCALE_MAX", "500"))
INITIAL_BALANCE = float(os.environ.get("SHIELD_INITIAL_BALANCE", "10000"))
DATE_FROM = os.environ.get("SHIELD_DATE_FROM", "2024-06-01").strip()

DCA_INTERVAL = "1h"
DCA_STEP_PERCENT = 0.5
DCA_TP_PERCENT = 1.2
DCA_MAX_ORDERS = 20
DCA_MARKETS = ["SUIUSDT", "TRXUSDT"]

V2_MACRO_EXIT_OVERLAY = {
    "anchorInterval": "1h",
    "rules": [],
    "localSelf": {
        "source": "self",
        "rsiPeriod": 14,
        "fractalWings": 2,
        "mode": "partial",
        "closeFraction": 0.35,
        "combineWith": "or",
        "longExitRsiAbove": 70,
        "shortExitRsiBelow": 20,
        "shortExitRsiAbove": 70,
        "label": "local_rsi1h",
    },
}
V2_STAT_ARB_ENTRY_GATE = {
    "gateInterval": "4h",
    "fractalWings": 2,
    "lookbackBars": 12,
    "longRequireBullishFractal": True,
    "shortRequireBearishFractal": True,
    "label": "self_frac4h_lb12",
}


def api_get(path: str, timeout: int = 120) -> dict:
    r = requests.get(f"{API}{path}", headers=HEADERS, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:400]}")
    return r.json()


def load_v2_snapshot(store: dict) -> dict:
    snaps = store.get("tsBacktestSnapshots") or {}
    for key in V2_SNAP_KEYS:
        snap = snaps.get(key)
        if snap and snap.get("offerIds"):
            return snap
    raise RuntimeError(f"No v2 snapshot in {V2_SNAP_KEYS}")


def extend_offer_weights(base_weights: dict | None, core_offer_ids: list[str], synth_offer_ids: list[str]) -> dict:
    weights: dict[str, float] = {}
    if isinstance(base_weights, dict):
        for oid in core_offer_ids:
            if oid in base_weights:
                weights[oid] = float(base_weights[oid])
    if not weights:
        core_share = max(0.0, 1.0 - SYNTH_WEIGHT_EACH * len(synth_offer_ids))
        per_core = core_share / max(1, len(core_offer_ids))
        weights = {oid: round(per_core, 6) for oid in core_offer_ids}
    for oid in synth_offer_ids:
        weights[oid] = SYNTH_WEIGHT_EACH
    total = sum(weights.values())
    if total <= 0:
        raise RuntimeError("offer weights sum to zero")
    return {k: round(v / total, 6) for k, v in weights.items()}


def extract_equity(raw, limit: int = 160) -> list[float]:
    points: list[float] = []
    for item in raw or []:
        val = item.get("equity", item.get("value")) if isinstance(item, dict) else item
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


def poll_combined_preview() -> dict:
    for _ in range(900):
        st = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if st.get("running"):
            time.sleep(2)
            continue
        if st.get("error"):
            raise RuntimeError(str(st["error"]))
        if st.get("result"):
            return st["result"]
        raise RuntimeError("Combined preview finished without result")
    raise RuntimeError("Combined preview timeout")


def build_backtest_settings(date_from: str, date_to: str) -> dict:
    return {
        "initialBalance": INITIAL_BALANCE,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "reinvestPercentOverride": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "lotPercent": LOT_PERCENT,
        "lotPercentOverride": LOT_PERCENT,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "enablePairLock": True,
        "dateFrom": date_from,
        "dateTo": date_to,
        "backtestBars": 8000,
        "warmupBars": 400,
        "macroShield": True,
        "macroExitOverlay": V2_MACRO_EXIT_OVERLAY,
        "statArbEntryGate": V2_STAT_ARB_ENTRY_GATE,
        "dcaEnabled": True,
        "dcaMarkets": DCA_MARKETS,
        "dcaInterval": DCA_INTERVAL,
        "dcaStepPercent": DCA_STEP_PERCENT,
        "dcaTpPercent": DCA_TP_PERCENT,
        "dcaMaxOrders": DCA_MAX_ORDERS,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": 4,
        "dcaAutotune": False,
    }


def build_combined_payload(
    *,
    offer_ids: list[str],
    offer_weights: dict,
    api_key: str,
    date_from: str,
    date_to: str,
) -> dict:
    tuning = {
        m: {
            "interval": DCA_INTERVAL,
            "stepPercent": DCA_STEP_PERCENT,
            "tpPercent": DCA_TP_PERCENT,
            "slPercent": 0,
            "entryFilter": "always",
            "perLegSl": False,
        }
        for m in DCA_MARKETS
    }
    return {
        "systemName": DEFAULT_SYSTEM_NAME,
        "setKey": SET_KEY,
        "apiKeyName": api_key,
        "dateFrom": date_from,
        "dateTo": date_to,
        "initialBalance": INITIAL_BALANCE,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "lotPercentOverride": LOT_PERCENT,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "enablePairLock": True,
        "offerIds": offer_ids,
        "offerWeightsById": offer_weights,
        "enabled": True,
        "markets": DCA_MARKETS,
        "marketTuning": tuning,
        "macroExitOverlay": V2_MACRO_EXIT_OVERLAY,
        "statArbEntryGate": V2_STAT_ARB_ENTRY_GATE,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": 4,
        "dcaInterval": DCA_INTERVAL,
        "dcaStepPercent": DCA_STEP_PERCENT,
        "dcaMaxOrders": DCA_MAX_ORDERS,
        "dcaTpPercent": DCA_TP_PERCENT,
        "dcaSlPercent": 0,
        "dcaEntryFilter": "always",
        "dcaReentryBars": 0,
        "dcaPerLegSl": False,
        "dcaAutotune": False,
        "macroShield": True,
    }


def patch_master_card_metadata(system_name: str) -> None:
    if not os.path.isfile(DB_PATH):
        print(f"WARN: DB not found at {DB_PATH}")
        return
    code = f"CARD::{system_name.upper()}"
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    row = cur.execute(
        "SELECT id, metadata_json FROM master_cards WHERE code = ? LIMIT 1",
        (code,),
    ).fetchone()
    meta: dict = {}
    if row and row[1]:
        try:
            meta = json.loads(str(row[1]))
        except json.JSONDecodeError:
            meta = {}
    meta.update({
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "lotPercentOverride": LOT_PERCENT,
        "reinvestPercentOverride": REINVEST_PERCENT,
        "macroShield": True,
        "macroExitOverlay": V2_MACRO_EXIT_OVERLAY,
        "statArbEntryGate": V2_STAT_ARB_ENTRY_GATE,
        "enablePairLock": True,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "category": "balanced-shield",
        "displayLabel": DISPLAY_LABEL,
        "synthAddonIds": SYNTH_STRATEGY_IDS,
    })
    if row:
        cur.execute(
            "UPDATE master_cards SET metadata_json = ?, updated_at = CURRENT_TIMESTAMP WHERE code = ?",
            (json.dumps(meta, ensure_ascii=False), code),
        )
    else:
        ts_row = cur.execute(
            "SELECT id FROM trading_systems WHERE name = ? LIMIT 1",
            (system_name,),
        ).fetchone()
        if not ts_row:
            raise RuntimeError(f"Trading system not found: {system_name}")
        cur.execute(
            """
            INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT(code) DO UPDATE SET
              name = excluded.name,
              description = excluded.description,
              source_system_id = excluded.source_system_id,
              is_active = 1,
              metadata_json = excluded.metadata_json,
              updated_at = CURRENT_TIMESTAMP
            """,
            (
                code,
                DISPLAY_LABEL,
                "v2 core + synth DD/ZZ decorr + macro shield + DCA",
                int(ts_row[0]),
                json.dumps(meta, ensure_ascii=False),
            ),
        )
    cur.execute(
        "UPDATE trading_systems SET max_open_positions = ?, updated_at = CURRENT_TIMESTAMP WHERE name = ?",
        (MAX_OPEN_POSITIONS, system_name),
    )
    conn.commit()
    conn.close()
    print(f"  master_card + TS max_op={MAX_OPEN_POSITIONS} ({code})")


def publish_members(store: dict, offer_ids: list[str]) -> str:
    offers_by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
    members = []
    for offer_id in offer_ids:
        offer = offers_by_id.get(offer_id) or {}
        strategy_id = int(offer.get("strategyId") or 0)
        if strategy_id <= 0:
            tail = offer_id.rsplit("_", 1)[-1]
            if tail.isdigit():
                strategy_id = int(tail)
        if strategy_id <= 0:
            raise RuntimeError(f"Cannot resolve strategyId for {offer_id}")
        members.append({
            "strategyId": strategy_id,
            "strategyName": str(offer.get("titleRu") or offer_id),
            "strategyType": str(offer.get("strategyType") or "DD_BattleToads"),
            "marketMode": "synthetic" if offer.get("mode") == "synth" or "synth" in offer_id else "mono",
            "market": str(offer.get("market") or ""),
            "score": float(offer.get("score") or 0),
            "weight": round(1 / max(1, len(offer_ids)), 4),
        })
    api_post("/api/saas/admin/curated-draft-members", {"members": members}, timeout=120)
    publish = api_post("/api/saas/admin/publish", {
        "offerIds": offer_ids,
        "setKey": SET_KEY,
        "editInPlace": True,
    }, timeout=300)
    system_name = str((publish.get("sourceSystem") or {}).get("systemName") or SYSTEM_NAME).strip()
    print(f"  published in-place: {system_name} ({len(offer_ids)} offers)")
    return system_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    date_to = datetime.now(timezone.utc).date().isoformat()
    date_from = DATE_FROM

    store = api_get("/api/saas/admin/offer-store")
    snap = load_v2_snapshot(store)
    core_offer_ids = list(dict.fromkeys(str(x).strip() for x in (snap.get("offerIds") or []) if str(x).strip()))
    base_weights = snap.get("offerWeightsById") if isinstance(snap.get("offerWeightsById"), dict) else None
    api_key = str(snap.get("apiKeyName") or "BTDD_D1")

    synth_to_add = [oid for oid in SYNTH_OFFER_IDS if oid not in core_offer_ids]
    offer_ids = list(dict.fromkeys([*core_offer_ids, *SYNTH_OFFER_IDS]))
    offer_weights = extend_offer_weights(base_weights, core_offer_ids, SYNTH_OFFER_IDS)

    print(f"v2 core offers: {len(core_offer_ids)} → combined: {len(offer_ids)} (+{len(synth_to_add)} synth)")
    print(f"Preset: lot={LOT_PERCENT}% reinvest={REINVEST_PERCENT}% OP={MAX_OPEN_POSITIONS} pairLock=True")
    print(f"Period: {date_from} → {date_to}")
    for oid in SYNTH_OFFER_IDS:
        print(f"  synth {oid} weight={offer_weights.get(oid)}")

    combined_payload = build_combined_payload(
        offer_ids=offer_ids,
        offer_weights=offer_weights,
        api_key=api_key,
        date_from=date_from,
        date_to=date_to,
    )
    print("\n=== Combined preview (TS+macro+DCA+synth, OP=20 lock) ===")
    api_post("/api/saas/admin/ts-dca-combined-preview", combined_payload, timeout=60)
    combined = poll_combined_preview()
    c_sum = (combined.get("combined") or {}).get("summary") or {}
    ts_sum = (combined.get("tsOnly") or {}).get("summary") or {}
    ret = float(c_sum.get("totalReturnPercent") or 0)
    dd = float(c_sum.get("maxDrawdownPercent") or 0)
    pf = float(c_sum.get("profitFactor") or 0)
    trades = int(c_sum.get("tradesCount") or 0)
    print(f"  COMBINED: ret={ret:.2f}% dd={dd:.2f}% pf={pf:.3f} trades={trades}")
    print(f"  TS only:  ret={float(ts_sum.get('totalReturnPercent') or 0):.2f}% dd={float(ts_sum.get('maxDrawdownPercent') or 0):.2f}%")

    if not args.apply:
        print("\nDry-run. Re-run with --apply --publish to update card + snapshot.")
        return

    system_name = str(snap.get("systemName") or DEFAULT_SYSTEM_NAME).strip()
    if args.publish:
        system_name = publish_members(store, offer_ids)
        dca_apply = {**combined_payload, "systemName": system_name, "maxApply": len(DCA_MARKETS)}
        applied = api_post("/api/saas/admin/ts-dca-pair-apply", dca_apply, timeout=600)
        print(f"  DCA re-applied: {[a.get('market') for a in (applied.get('applied') or [])]}")

    period_days = max(1, (datetime.fromisoformat(date_to).date() - datetime.fromisoformat(date_from).date()).days)
    dca_layer = snap.get("dcaLayer") if isinstance(snap.get("dcaLayer"), dict) else {}
    tuning = dca_layer.get("tuning") or combined_payload.get("marketTuning") or {}
    snapshot = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "offerWeightsById": offer_weights,
        "apiKeyName": api_key,
        "systemName": system_name,
        "ret": ret,
        "pf": pf,
        "dd": dd,
        "trades": trades,
        "finalEquity": float(c_sum.get("finalEquity") or INITIAL_BALANCE),
        "periodDays": period_days,
        "winRate": float(c_sum.get("winRatePercent") or 0),
        "tradesPerDay": round(trades / period_days, 3),
        "equityPoints": extract_equity((combined.get("combined") or {}).get("equity")),
        "backtestSettings": build_backtest_settings(date_from, date_to),
        "dcaLayer": {
            "markets": DCA_MARKETS,
            "macroExitOverlay": V2_MACRO_EXIT_OVERLAY,
            "statArbEntryGate": V2_STAT_ARB_ENTRY_GATE,
            "tuning": tuning,
            "synthAddonIds": SYNTH_STRATEGY_IDS,
        },
    }
    current_published = list(store.get("algofundPublishedSystemNames") or [])
    next_published = list(dict.fromkeys([system_name, *current_published]))
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": next_published,
    })
    patch_master_card_metadata(system_name)
    print(f"\nDone: {system_name}")
    print(f"  snapshot ret={ret:.2f}% dd={dd:.2f}% offers={len(offer_ids)} OP={MAX_OPEN_POSITIONS}")


if __name__ == "__main__":
    main()

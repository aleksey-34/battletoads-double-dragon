#!/usr/bin/env python3
"""
Create NEW card: Balanced Shield + DCA v2 Synth (v2dca_dense winner preset).

Add-on model: keep legacy 42 core + 4 new SYNTHDECORR offers (46 total).
Does NOT touch existing balanced-shield-dca-v2-c66g2i (1 client pilot).

  python3 scripts/admin_tools/storefront/build_balanced_shield_dca_v2_synth_card.py
  python3 scripts/admin_tools/storefront/build_balanced_shield_dca_v2_synth_card.py --apply --publish
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

SET_KEY = "balanced-shield-dca-v2-synth"
DISPLAY_LABEL = "Balanced Shield + DCA v2 Synth"
# Engine context: reuse v2 snapshot resolution (new setKey breaks strategy pick)
ENGINE_SET_KEY = "balanced-shield-dca-v2"
ENGINE_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-c66g2i"
DATE_FROM = "2025-01-01"

# v2dca_dense winner
LOT_PERCENT = 20.0
MAX_OPEN_POSITIONS = 15
RISK_SCORE = 10.0
TRADE_FREQ = 10.0
REINVEST_PERCENT = 100.0
RISK_SCALE_MAX = 500.0
INITIAL_BALANCE = 10000.0
DCA_BASE_PCT = 4.0

NEW_SYNTH = [
    "offer_synth_dd_battletoads_233831",
    "offer_mono_dd_battletoads_233498",
    "offer_synth_stat_arb_zscore_232383",
    "offer_synth_stat_arb_zscore_234543",
]
DCA_MARKETS = ["SUIUSDT", "TRXUSDT"]
DCA_TUNING = {
    "interval": "1h",
    "stepPercent": 0.5,
    "tpPercent": 1.2,
    "slPercent": 0,
    "entryFilter": "always",
    "perLegSl": False,
}

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


def poll_combined() -> dict:
    for _ in range(60):
        time.sleep(1)
        st = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if st.get("running") or st.get("result"):
            break
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


def extract_equity(raw, limit: int = 160) -> list[float]:
    pts: list[float] = []
    for item in raw or []:
        val = item.get("equity", item.get("value")) if isinstance(item, dict) else item
        if val is None:
            continue
        try:
            pts.append(round(float(val), 2))
        except (TypeError, ValueError):
            pass
    if len(pts) <= limit:
        return pts
    step = max(1, len(pts) // limit)
    out = pts[::step]
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out[:limit]


def load_offer_ids(store: dict) -> tuple[list[str], dict[str, float]]:
    snap = (store.get("tsBacktestSnapshots") or {}).get("balanced-shield-dca-v2") or {}
    core = list(dict.fromkeys(str(x).strip() for x in (snap.get("offerIds") or []) if str(x).strip()))
    addon = [o for o in NEW_SYNTH if o not in core]
    offer_ids = list(dict.fromkeys([*core, *addon]))
    weights = {oid: round(1 / len(offer_ids), 6) for oid in offer_ids}
    return offer_ids, weights


def build_combined_payload(
    offer_ids: list[str],
    weights: dict[str, float],
    api_key: str,
    date_from: str,
    date_to: str,
) -> dict:
    tuning = {m: DCA_TUNING for m in DCA_MARKETS}
    return {
        "systemName": ENGINE_SYSTEM,
        "setKey": ENGINE_SET_KEY,
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
        "offerWeightsById": weights,
        "enabled": True,
        "markets": DCA_MARKETS,
        "marketTuning": tuning,
        "macroExitOverlay": V2_MACRO,
        "macroShield": True,
        "statArbEntryGate": STAT_GATE,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": DCA_BASE_PCT,
        "dcaInterval": DCA_TUNING["interval"],
        "dcaStepPercent": DCA_TUNING["stepPercent"],
        "dcaTpPercent": DCA_TUNING["tpPercent"],
        "dcaMaxOrders": 20,
        "dcaSlPercent": 0,
        "dcaAutotune": False,
    }


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
        "macroShield": True,
        "macroExitOverlay": V2_MACRO,
        "statArbEntryGate": STAT_GATE,
        "dcaEnabled": True,
        "dcaMarkets": DCA_MARKETS,
        "dcaInterval": DCA_TUNING["interval"],
        "dcaStepPercent": DCA_TUNING["stepPercent"],
        "dcaTpPercent": DCA_TUNING["tpPercent"],
        "dcaMaxOrders": 20,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": DCA_BASE_PCT,
        "dcaAutotune": False,
        "preset": "v2dca_dense",
        "synthAddonIds": NEW_SYNTH,
        "synthModel": "add_on_keep_legacy",
    }


def patch_master_card(system_name: str) -> None:
    if not os.path.isfile(DB_PATH):
        print(f"WARN: DB missing: {DB_PATH}")
        return
    code = f"CARD::{system_name.upper()}"
    meta = {
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "lotPercentOverride": LOT_PERCENT,
        "reinvestPercentOverride": REINVEST_PERCENT,
        "macroShield": True,
        "macroExitOverlay": V2_MACRO,
        "statArbEntryGate": STAT_GATE,
        "enablePairLock": True,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "category": "balanced-shield",
        "displayLabel": DISPLAY_LABEL,
        "synthAddonIds": NEW_SYNTH,
        "tunePreset": "v2dca_dense",
    }
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    ts = cur.execute("SELECT id FROM trading_systems WHERE name=? LIMIT 1", (system_name,)).fetchone()
    row = cur.execute("SELECT id FROM master_cards WHERE code=? LIMIT 1", (code,)).fetchone()
    if row:
        cur.execute(
            "UPDATE master_cards SET metadata_json=?, name=?, updated_at=CURRENT_TIMESTAMP WHERE code=?",
            (json.dumps(meta, ensure_ascii=False), DISPLAY_LABEL, code),
        )
    elif ts:
        cur.execute(
            """
            INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
            VALUES (?, ?, ?, ?, 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            """,
            (code, DISPLAY_LABEL, "v2 + synth add-on, v2dca_dense preset", int(ts[0]), json.dumps(meta, ensure_ascii=False)),
        )
    if ts:
        cur.execute(
            "UPDATE trading_systems SET max_open_positions=?, updated_at=CURRENT_TIMESTAMP WHERE id=?",
            (MAX_OPEN_POSITIONS, ts[0]),
        )
    conn.commit()
    conn.close()
    print(f"  master_card: {code}")


def enable_vitrine(system_name: str) -> int:
    if not os.path.isfile(DB_PATH):
        return 0
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    profiles = cur.execute("SELECT id FROM algofund_profiles").fetchall()
    for (pid,) in profiles:
        cur.execute(
            """
            INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
            VALUES (?, ?, 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
            ON CONFLICT (profile_id, system_name) DO UPDATE SET is_enabled=1, updated_at=CURRENT_TIMESTAMP
            """,
            (pid, system_name),
        )
    conn.commit()
    conn.close()
    return len(profiles)


def publish_new_card(store: dict, offer_ids: list[str], weights: dict[str, float], api_key: str,
                     combined: dict, c_sum: dict, date_from: str, date_to: str) -> str:
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
    api_post("/api/saas/admin/curated-draft-members", {"members": members}, timeout=120)
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

    dca_payload = build_combined_payload(offer_ids, weights, api_key, date_from, date_to)
    applied = api_post("/api/saas/admin/ts-dca-pair-apply", {
        **dca_payload, "maxApply": len(DCA_MARKETS),
    }, timeout=600)
    print(f"  published: {system_name} ({len(offer_ids)} offers)")
    print(f"  DCA applied: {[a.get('market') for a in (applied.get('applied') or [])]}")

    trades = int(c_sum.get("tradesCount") or 0)
    period_days = max(1, (datetime.fromisoformat(date_to).date() - datetime.fromisoformat(date_from).date()).days)
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
        "equityPoints": extract_equity((combined.get("combined") or {}).get("equity")),
        "backtestSettings": build_backtest_settings(date_from, date_to),
        "dcaLayer": {
            "markets": DCA_MARKETS,
            "macroExitOverlay": V2_MACRO,
            "statArbEntryGate": STAT_GATE,
            "tuning": {m: DCA_TUNING for m in DCA_MARKETS},
            "synthAddonIds": NEW_SYNTH,
            "tunePreset": "v2dca_dense",
        },
    }
    published = list(store.get("algofundPublishedSystemNames") or [])
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {SET_KEY: snapshot, system_name: snapshot},
        "algofundPublishedSystemNames": list(dict.fromkeys([system_name, *published])),
    })
    patch_master_card(system_name)
    n = enable_vitrine(system_name)
    print(f"  vitrine enabled for {n} profiles")
    return system_name


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    parser.add_argument("--publish", action="store_true")
    args = parser.parse_args()
    if args.publish:
        args.apply = True

    date_to = datetime.now(timezone.utc).date().isoformat()
    store = api_get("/api/saas/admin/offer-store")
    offer_ids, weights = load_offer_ids(store)
    api_key = str(((store.get("tsBacktestSnapshots") or {}).get("balanced-shield-dca-v2") or {}).get("apiKeyName") or "BTDD_D1")
    draft_system = f"ALGOFUND_MASTER::BTDD_D1::{SET_KEY}"

    print(f"NEW card: {DISPLAY_LABEL}")
    print(f"  offers: {len(offer_ids)} (core + {len(NEW_SYNTH)} synth add-on)")
    print(f"  preset v2dca_dense: lot={LOT_PERCENT}% OP={MAX_OPEN_POSITIONS} freq={TRADE_FREQ} reinvest={REINVEST_PERCENT}%")
    print(f"  DCA: {DCA_TUNING['interval']} step={DCA_TUNING['stepPercent']}% TP={DCA_TUNING['tpPercent']}%")
    print(f"  period: {DATE_FROM} → {date_to}\n")

    seed = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "offerWeightsById": weights,
        "apiKeyName": api_key,
        "systemName": draft_system,
        "ret": 0, "pf": 0, "dd": 0, "trades": 0,
        "backtestSettings": build_backtest_settings(DATE_FROM, date_to),
    }
    api_patch("/api/saas/admin/offer-store", {"tsBacktestSnapshotsPatch": {SET_KEY: seed}})

    payload = build_combined_payload(offer_ids, weights, api_key, DATE_FROM, date_to)
    print("=== Combined preview ===")
    api_post("/api/saas/admin/ts-dca-combined-preview", payload, timeout=60)
    combined = poll_combined()
    c_sum = (combined.get("combined") or {}).get("summary") or {}
    ts_sum = (combined.get("tsOnly") or {}).get("summary") or {}
    ret = float(c_sum.get("totalReturnPercent") or 0)
    dd = float(c_sum.get("maxDrawdownPercent") or 0)
    pf = float(c_sum.get("profitFactor") or 0)
    trades = int(c_sum.get("tradesCount") or 0)
    print(f"  COMBINED: ret={ret:.2f}% dd={dd:.2f}% pf={pf:.3f} trades={trades}")
    print(f"  TS only:  ret={float(ts_sum.get('totalReturnPercent') or 0):.2f}% dd={float(ts_sum.get('maxDrawdownPercent') or 0):.2f}%")

    if not args.apply:
        print("\nDry-run. Re-run with --apply --publish to create card + vitrine.")
        return

    if args.publish:
        system_name = publish_new_card(store, offer_ids, weights, api_key, combined, c_sum, DATE_FROM, date_to)
        print(f"\nDone: {system_name}")
        print(f"  snapshot ret={ret:.2f}% dd={dd:.2f}% — review in SaaS admin before assigning clients")
    else:
        snap = {
            "setKey": SET_KEY,
            "displayLabel": DISPLAY_LABEL,
            "offerIds": offer_ids,
            "offerWeightsById": weights,
            "systemName": draft_system,
            "ret": ret, "dd": dd, "pf": pf, "trades": trades,
            "backtestSettings": build_backtest_settings(DATE_FROM, date_to),
        }
        api_patch("/api/saas/admin/offer-store", {"tsBacktestSnapshotsPatch": {SET_KEY: snap}})
        print(f"\nSnapshot saved: {SET_KEY}")


if __name__ == "__main__":
    main()

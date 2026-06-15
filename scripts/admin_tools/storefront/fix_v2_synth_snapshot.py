#!/usr/bin/env python3
"""
Rebuild v2-synth card snapshot: full sweep depth (~742d), v2dca_dense DCA, approved mechanics.

  BTDD_API=http://127.0.0.1:3001 python3 scripts/admin_tools/storefront/fix_v2_synth_snapshot.py
  ... --apply
"""
from __future__ import annotations

import argparse
import json
import os
import sqlite3
import sys
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
SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-synth-kka4ic"
ENGINE_SET_KEY = "balanced-shield-dca-v2"
ENGINE_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::balanced-shield-dca-v2-c66g2i"

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
STAT_GATE = {
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
        raise RuntimeError(f"GET {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def api_post(path: str, payload: dict, timeout: int = 900) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def api_patch(path: str, payload: dict, timeout: int = 120) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path} -> {r.status_code}: {r.text[:500]}")
    return r.json()


def poll_combined(max_wait_sec: int = 1800) -> dict:
    for _ in range(60):
        time.sleep(1)
        st = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if st.get("running") or st.get("result"):
            break
    deadline = time.time() + max_wait_sec
    while time.time() < deadline:
        st = api_get("/api/saas/admin/ts-dca-combined-preview-status")
        if st.get("running"):
            msg = st.get("message") or "running"
            print(f"  combined preview… {msg}", flush=True)
            time.sleep(5)
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
        pts.append(float(val))
    if not pts:
        return []
    step = max(1, len(pts) // limit)
    out = pts[::step]
    if out[-1] != pts[-1]:
        out.append(pts[-1])
    return out[:limit]


def load_offer_ids(store: dict) -> tuple[list[str], dict[str, float], str]:
    snap = (
        store.get("tsBacktestSnapshots", {}).get(SYSTEM)
        or store.get("tsBacktestSnapshots", {}).get(SET_KEY)
        or store.get("tsBacktestSnapshots", {}).get("balanced-shield-dca-v2")
        or {}
    )
    core = list(dict.fromkeys(str(x).strip() for x in (snap.get("offerIds") or []) if str(x).strip()))
    if len(core) < 40:
        core = list(dict.fromkeys(
            str(x).strip()
            for x in (store.get("tsBacktestSnapshots", {}).get("balanced-shield-dca-v2") or {}).get("offerIds") or []
            if str(x).strip()
        ))
    oids = list(dict.fromkeys([*core, *[o for o in NEW_SYNTH if o not in core]]))
    weights = {oid: round(1 / len(oids), 6) for oid in oids}
    api_key = str(snap.get("apiKeyName") or "BTDD_D1")
    return oids, weights, api_key


def build_combined_payload(offer_ids: list[str], weights: dict[str, float], api_key: str) -> dict:
    """Full sweep depth: omit dateFrom/dateTo → backend uses sweep.config.dateFrom (~2024-06-01)."""
    tuning = {m: DCA_TUNING for m in DCA_MARKETS}
    return {
        "systemName": SYSTEM,
        "setKey": SET_KEY,
        "apiKeyName": api_key,
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
        "statArbEntryGate": STAT_GATE,
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": DCA_BASE_PCT,
        "dcaInterval": DCA_TUNING["interval"],
        "dcaStepPercent": DCA_TUNING["stepPercent"],
        "dcaTpPercent": DCA_TUNING["tpPercent"],
        "dcaMaxOrders": 20,
        "dcaSlPercent": 0,
        "dcaAutotune": False,
        "dcaPerLegSl": False,
    }


def build_dca_layer() -> dict:
    return {
        "enabled": True,
        "markets": DCA_MARKETS,
        "tuning": {m: DCA_TUNING for m in DCA_MARKETS},
        "macroExitOverlay": V2_MACRO,
        "statArbEntryGate": STAT_GATE,
        "tunePreset": "v2dca_dense",
        "dcaBaseAmountMode": "percent",
        "dcaBaseAmountPercent": DCA_BASE_PCT,
        "dcaInterval": DCA_TUNING["interval"],
        "dcaStepPercent": DCA_TUNING["stepPercent"],
        "dcaTpPercent": DCA_TUNING["tpPercent"],
        "dcaMaxOrders": 20,
        "dcaAutotune": False,
        "dcaEntryFilter": "always",
        "dcaPerLegSl": False,
    }


def build_backtest_settings(period: dict | None) -> dict:
    date_from = str((period or {}).get("dateFrom") or "").strip()
    date_to = str((period or {}).get("dateTo") or "").strip()
    return {
        "initialBalance": INITIAL_BALANCE,
        "riskScore": RISK_SCORE,
        "tradeFrequencyScore": TRADE_FREQ,
        "reinvestPercent": REINVEST_PERCENT,
        "riskScaleMaxPercent": RISK_SCALE_MAX,
        "lotPercentOverride": LOT_PERCENT,
        "maxOpenPositions": MAX_OPEN_POSITIONS,
        "enablePairLock": True,
        "autoLotByChannelWidth": False,
        "dcaPerLegSl": False,
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
        **({"dateFrom": date_from, "dateTo": date_to} if date_from and date_to else {}),
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
        "dcaEnabled": True,
        "dcaMarkets": DCA_MARKETS,
    }
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    row = cur.execute("SELECT id FROM master_cards WHERE code=? LIMIT 1", (code,)).fetchone()
    if row:
        cur.execute(
            "UPDATE master_cards SET metadata_json=?, name=?, updated_at=CURRENT_TIMESTAMP WHERE code=?",
            (json.dumps(meta, ensure_ascii=False), DISPLAY_LABEL, code),
        )
        print(f"  master_card metadata patched: {code}")
    else:
        print(f"  WARN: master_card not found: {code}")
    conn.commit()
    conn.close()


def publish_card_overrides() -> None:
    api_post("/api/saas/admin/publish", {
        "setKey": SET_KEY,
        "editInPlace": True,
        "propagateToClients": False,
        "cardOverrides": {
            "lotPercentOverride": LOT_PERCENT,
            "maxOpenPositions": MAX_OPEN_POSITIONS,
            "reinvestPercentOverride": REINVEST_PERCENT,
            "macroShield": True,
            "macroExitOverlay": V2_MACRO,
            "statArbEntryGate": STAT_GATE,
            "tunePreset": "v2dca_dense",
            "enablePairLock": True,
            "dcaEnabled": True,
            "dcaMarkets": DCA_MARKETS,
            "dcaPerLegSl": False,
        },
    }, timeout=120)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true", help="Run combined preview + patch snapshot")
    args = parser.parse_args()

    store = api_get("/api/saas/admin/offer-store")
    offer_ids, weights, api_key = load_offer_ids(store)
    print(f"Card: {SET_KEY} / {SYSTEM}")
    print(f"  offers: {len(offer_ids)}, apiKey: {api_key}")
    print(f"  DCA: {DCA_MARKETS}, preset v2dca_dense, full sweep depth (no date override)")

    payload = build_combined_payload(offer_ids, weights, api_key)
    if not args.apply:
        print("\nDry-run payload keys:", list(payload.keys()))
        print("Re-run with --apply to compute combined + fix snapshot")
        return

    print("\n=== Combined preview (full depth) ===")
    api_post("/api/saas/admin/ts-dca-combined-preview", payload, timeout=60)
    combined = poll_combined()
    period = combined.get("period") or {}
    c_sum = (combined.get("combined") or {}).get("summary") or {}
    ts_sum = (combined.get("tsOnly") or {}).get("summary") or {}
    ret = float(c_sum.get("totalReturnPercent") or 0)
    dd = float(c_sum.get("maxDrawdownPercent") or 0)
    pf = float(c_sum.get("profitFactor") or 0)
    trades = int(c_sum.get("tradesCount") or 0)
    final_equity = float(c_sum.get("finalEquity") or INITIAL_BALANCE)
    win_rate = float(c_sum.get("winRatePercent") or 0)
    date_from = str(period.get("dateFrom") or "")
    date_to = str(period.get("dateTo") or "")
    period_days = max(1, (datetime.fromisoformat(date_to).date() - datetime.fromisoformat(date_from).date()).days) if date_from and date_to else 742

    print(f"  period: {date_from} → {date_to} ({period_days}d, fullDepth={period.get('fullDepth')})")
    print(f"  COMBINED: ret={ret:.2f}% dd={dd:.2f}% pf={pf:.3f} trades={trades}")
    print(f"  TS only:  ret={float(ts_sum.get('totalReturnPercent') or 0):.2f}% dd={float(ts_sum.get('maxDrawdownPercent') or 0):.2f}%")

    dca_layer = build_dca_layer()
    snapshot = {
        "setKey": SET_KEY,
        "displayLabel": DISPLAY_LABEL,
        "offerIds": offer_ids,
        "offerWeightsById": weights,
        "apiKeyName": api_key,
        "systemName": SYSTEM,
        "ret": ret,
        "pf": pf,
        "dd": dd,
        "trades": trades,
        "finalEquity": final_equity,
        "periodDays": period_days,
        "winRate": win_rate,
        "tradesPerDay": round(trades / period_days, 3),
        "equityPoints": extract_equity((combined.get("combined") or {}).get("equity")),
        "backtestSettings": build_backtest_settings(period),
        "dcaMarkets": DCA_MARKETS,
        "macroShield": True,
        "dcaLayer": dca_layer,
    }

    print("\n=== Patch snapshot + master_card ===")
    api_patch("/api/saas/admin/offer-store", {
        "tsBacktestSnapshotsPatch": {
            SET_KEY: snapshot,
            SYSTEM: snapshot,
        },
    })
    patch_master_card(SYSTEM)
    try:
        publish_card_overrides()
        print("  publish cardOverrides: OK")
    except Exception as exc:
        print(f"  publish cardOverrides skipped: {exc}")

    print(f"\nDone: {SYSTEM}")
    print(f"  snapshot ret={ret:.2f}% dd={dd:.2f}% trades={trades} period={period_days}d")


if __name__ == "__main__":
    main()

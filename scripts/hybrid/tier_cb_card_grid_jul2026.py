#!/usr/bin/env python3
"""Honest tier-CB vs full-CB (+ fat / channel) across eligible multi-layer cards."""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH = "Bearer btdd_admin_sweep_2026"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", "/opt/battletoads-double-dragon/backend/database.db")
OUT = os.environ.get(
    "OUT",
    "/opt/battletoads-double-dragon/results/tier_cb_card_grid_jul2026.json",
)
DATE_FROM = "2024-06-01"
DATE_TO = datetime.now(timezone.utc).date().isoformat()
INITIAL = 10000.0
BARS = 9000

# Eligible: has zz_breakout + (mom or synth)
CARDS = [
    {"label": "B3", "systemId": 205, "lot": 15, "op": 12, "ri": 50,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}},
    {"label": "Boost_L25", "systemId": 210, "lot": 25, "op": 12, "ri": 50,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14}},
    {"label": "Boost_L22", "systemId": 211, "lot": 22, "op": 14, "ri": 75,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 12, "lotMultiplier": 0.75, "pauseDays": 7}},
    {"label": "Boost_L28", "systemId": 212, "lot": 28, "op": 14, "ri": 50,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 12, "lotMultiplier": 0.75, "pauseDays": 7}},
    {"label": "Boost_L32_Nuke", "systemId": 213, "lot": 32, "op": 16, "ri": 75,
     # card has CB off — enable MED for fair tier test + also keep off baseline
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 8, "lotMultiplier": 0.5, "pauseDays": 14},
     "alsoCbOff": True},
    {"label": "Cloud_L400", "systemId": 208, "lot": 20, "op": 8, "ri": 75,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 12, "lotMultiplier": 0.75, "pauseDays": 7}},
    {"label": "Turbo", "systemId": 209, "lot": 22, "op": 10, "ri": 75,
     "cb": {"enabled": True, "peakWindowDays": 30, "ddTriggerPercent": 12, "lotMultiplier": 0.75, "pauseDays": 7}},
]

FAT = {
    "enabled": True,
    "minLosingLegs": 5,
    "lotMultiplier": 0.5,
    "pauseDays": 1,
    "strategyTypes": ["zz_breakout"],
    "baseSymbols": ["ORDIUSDT", "WLDUSDT", "INJUSDT", "ARBUSDT"],
}
HOT_ALL_BREAK = {
    "enabled": True,
    "minLosingLegs": 5,
    "lotMultiplier": 0.5,
    "pauseDays": 1,
    "strategyTypes": ["zz_breakout"],
}


def api_post(path: str, payload: dict, timeout: int = 2400) -> dict:
    last = None
    for attempt in range(60):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except Exception as exc:  # noqa: BLE001
            last = exc
            time.sleep(6 + attempt)
            continue
        err = str(data.get("error") or "")
        if "already running" in err.lower() and attempt < 59:
            time.sleep(10 + attempt)
            continue
        if data.get("success") is False or (err and not data.get("result")):
            raise RuntimeError(err or str(data)[:400])
        return data
    raise RuntimeError(f"api_post failed: {last}")


def metrics(result: dict) -> dict:
    s = result.get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "cbTriggers": int(s.get("portfolioCircuitBreakerTriggers") or 0),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
    }


def growth_cap(reinvest: float) -> float:
    return min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0.0


def member_ids(conn: sqlite3.Connection, system_id: int) -> list[int]:
    rows = conn.execute(
        """SELECT s.id FROM trading_system_members m
           JOIN strategies s ON s.id=m.strategy_id
           WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1 ORDER BY s.id""",
        (system_id,),
    ).fetchall()
    return [int(r[0]) for r in rows]


def run(sids: list[int], card: dict, *, cb: dict | None, fat=None, auto_lot=False, stop_frac=0.0) -> dict:
    ri = float(card["ri"])
    growth = growth_cap(ri)
    payload = {
        "apiKeyName": "BTDD_D1",
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": BARS,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": int(card["op"]),
        "lotPercentOverride": float(card["lot"]),
        "reinvestPercentOverride": ri,
        "maxDepositOverride": INITIAL * growth if growth else 0,
        "lotPercentMultiplierByStrategyId": {str(i): 1.0 for i in sids},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "autoLotByChannelWidth": bool(auto_lot),
    }
    if cb is not None:
        payload["portfolioCircuitBreaker"] = cb
    if fat is not None:
        payload["fatTailSyncCooldown"] = fat
    if stop_frac and stop_frac > 0:
        payload["channelWidthStopFraction"] = float(stop_frac)
    t0 = time.time()
    data = api_post("/api/backtest/run", payload)
    m = metrics(data.get("result") or {})
    m["elapsedSec"] = round(time.time() - t0, 1)
    return m


def main() -> None:
    conn = sqlite3.connect(DB)
    table = []
    print(f"DATE {DATE_FROM}->{DATE_TO}", flush=True)

    for card in CARDS:
        sids = member_ids(conn, card["systemId"])
        if not sids:
            print(f"skip {card['label']}: no members", flush=True)
            continue
        print(f"\n===== {card['label']} legs={len(sids)} lot={card['lot']} op={card['op']} =====", flush=True)
        base_cb = dict(card["cb"])
        tier_cb = {**base_cb, "applyToStrategyTypes": ["zz_breakout"]}

        variants = []
        if card.get("alsoCbOff"):
            variants.append(("cb_off", {"cb": {"enabled": False}}))
        variants.extend([
            ("full_CB", {"cb": base_cb}),
            ("tier_CB_breakout", {"cb": tier_cb}),
            ("tier_CB+fat_hot", {"cb": tier_cb, "fat": FAT}),
            ("tier_CB+fat_allBreak", {"cb": tier_cb, "fat": HOT_ALL_BREAK}),
            ("tier_CB+autoLotChannel", {"cb": tier_cb, "auto_lot": True}),
            ("combo_tier+fat_hot+autoLot", {"cb": tier_cb, "fat": FAT, "auto_lot": True}),
            ("tier_CB+stopChan0.35", {"cb": tier_cb, "stop_frac": 0.35}),
            ("tier_CB+stopChan0.50", {"cb": tier_cb, "stop_frac": 0.50}),
        ])

        card_rows = []
        base_m = None
        for name, opts in variants:
            print(f"  -> {name}", flush=True)
            try:
                m = run(
                    sids,
                    card,
                    cb=opts.get("cb"),
                    fat=opts.get("fat"),
                    auto_lot=bool(opts.get("auto_lot")),
                    stop_frac=float(opts.get("stop_frac") or 0),
                )
            except Exception as exc:  # noqa: BLE001
                print(f"  FAIL {name}: {exc}", flush=True)
                card_rows.append({"variant": name, "error": str(exc)[:300]})
                continue
            if name == "full_CB":
                base_m = m
            row = {"variant": name, **m}
            if base_m:
                row["dRet"] = round(m["ret"] - base_m["ret"], 2)
                row["dDd"] = round(m["dd"] - base_m["dd"], 2)
            print(f"     {m}", flush=True)
            card_rows.append(row)

        table.append({
            "label": card["label"],
            "systemId": card["systemId"],
            "legs": len(sids),
            "settings": {"lot": card["lot"], "op": card["op"], "ri": card["ri"], "cb": base_cb},
            "rows": card_rows,
        })

    doc = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "explain": {
            "full_CB": "Current: DD trigger cuts lot on ALL legs",
            "tier_CB_breakout": "Same DD trigger, cut ONLY zz_breakout; mom+synth full size",
            "tier_CB+fat_hot": "tier + next day after sync5: x0.5 on ORDI/WLD/INJ/ARB breakout",
            "tier_CB+fat_allBreak": "tier + next day after sync5: x0.5 on ALL zz_breakout",
            "tier_CB+autoLotChannel": "tier + inverse Donchian/ZZ width lot sizing",
            "combo": "tier + fat_hot + autoLot",
            "stopChan": "tier + stop at fraction of channel width from entry (vs center)",
        },
        "cards": table,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(doc, f, indent=2, ensure_ascii=False)
    print("\nWrote", OUT, flush=True)


if __name__ == "__main__":
    main()

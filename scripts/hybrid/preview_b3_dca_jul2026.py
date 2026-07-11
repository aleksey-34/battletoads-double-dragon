#!/usr/bin/env python3
"""Preview: base B3 vs B3+DCA (combined portfolio) — no publish."""
from __future__ import annotations

import json
import os
import time
from datetime import datetime, timezone

import requests

API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
B3_SYSTEM = "ALGOFUND_MASTER::BTDD_D1::synth-stable-union-v4-4-b3-jul2026-wylwez"
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
OUT = os.environ.get(
    "OUT",
    "/opt/battletoads-double-dragon/results/b3_dca_preview_jul2026.json",
)

# denser DCA presets to try on top of B3
PRESETS = [
    {
        "name": "shield_dense_sui_trx",
        "markets": ["SUIUSDT", "TRXUSDT"],
        "dcaSettings": {
            "interval": "1h",
            "stepPercent": 0.5,
            "tpPercent": 1.2,
            "maxOrders": 20,
            "baseAmountPercent": 4.0,
            "baseAmountMode": "percent",
        },
    },
    {
        "name": "classic_2pct_btc_eth",
        "markets": ["BTCUSDT", "ETHUSDT"],
        "dcaSettings": {
            "interval": "4h",
            "stepPercent": 2.0,
            "tpPercent": 3.0,
            "maxOrders": 5,
            "baseAmountPercent": 2.0,
            "baseAmountMode": "percent",
        },
    },
    {
        "name": "classic_2pct_near_inj",
        "markets": ["NEARUSDT", "INJUSDT"],
        "dcaSettings": {
            "interval": "4h",
            "stepPercent": 2.0,
            "tpPercent": 3.0,
            "maxOrders": 5,
            "baseAmountPercent": 2.0,
            "baseAmountMode": "percent",
        },
    },
]


def api_post(path: str, payload: dict, timeout: int = 1800) -> dict:
    r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
    try:
        data = r.json()
    except Exception:
        raise RuntimeError(f"POST {path} HTTP {r.status_code}: {r.text[:400]}")
    if r.status_code >= 400:
        raise RuntimeError(f"POST {path} HTTP {r.status_code}: {data}")
    return data


def summarize(block: dict | None) -> dict:
    if not block:
        return {}
    s = block.get("summary") or block
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "wr": round(float(s.get("winRatePercent") or 0), 1),
        "finalEquity": round(float(s.get("finalEquity") or 0), 2),
    }


def main() -> None:
    print(f"B3={B3_SYSTEM}\nDATE {DATE_FROM}→{DATE_TO}", flush=True)

    print("\n=== pick DCA markets for B3 ===", flush=True)
    pick = api_post(
        "/api/saas/admin/ts-dca-pair-pick",
        {
            "systemName": B3_SYSTEM,
            "apiKeyName": "BTDD_D1",
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "maxCandidates": 8,
            "initialBalance": 10000,
            "interval": "4h",
            "stepPercent": 2.0,
            "tpPercent": 3.0,
            "maxOrders": 5,
            "baseAmountPercent": 2.0,
            "baseAmountMode": "percent",
        },
        timeout=1800,
    )
    picks = pick.get("picks") or pick.get("candidates") or pick.get("markets") or []
    print("pick keys", list(pick.keys())[:20], flush=True)
    print("picks sample", json.dumps(picks[:5] if isinstance(picks, list) else picks, ensure_ascii=False)[:800], flush=True)

    auto_markets = []
    if isinstance(picks, list):
        for p in picks:
            if isinstance(p, str):
                auto_markets.append(p.upper())
            elif isinstance(p, dict):
                m = p.get("market") or p.get("symbol") or p.get("baseSymbol")
                if m:
                    auto_markets.append(str(m).upper().replace("/", ""))
                    if not str(m).upper().endswith("USDT"):
                        auto_markets[-1] = str(m).upper() + "USDT"
    auto_markets = list(dict.fromkeys(auto_markets))[:3]
    if auto_markets:
        PRESETS.insert(
            0,
            {
                "name": "auto_pick",
                "markets": auto_markets,
                "dcaSettings": {
                    "interval": "4h",
                    "stepPercent": 2.0,
                    "tpPercent": 3.0,
                    "maxOrders": 5,
                    "baseAmountPercent": 2.0,
                    "baseAmountMode": "percent",
                },
            },
        )

    results = {"generatedAt": datetime.now(timezone.utc).isoformat(), "pick": pick, "runs": []}
    for preset in PRESETS:
        print(f"\n=== combined {preset['name']} markets={preset['markets']} ===", flush=True)
        t0 = time.time()
        body = {
            "systemName": B3_SYSTEM,
            "apiKeyName": "BTDD_D1",
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": 10000,
            "markets": preset["markets"],
            "maxOpenPositions": 12,
            "enabled": True,
            "lotPercentOverride": 15,
            "reinvestPercent": 50,
            "riskScore": 5,
            "riskScaleMaxPercent": 100,
            **preset["dcaSettings"],
        }
        try:
            data = api_post("/api/saas/admin/ts-dca-combined-preview-sync", body, timeout=2400)
        except Exception as e:
            print(f"  FAIL {e}", flush=True)
            results["runs"].append({"name": preset["name"], "error": str(e), **preset})
            continue
        ts_only = summarize(data.get("tsOnly") or data.get("tsPreview") or data.get("ts"))
        dca_only = summarize(data.get("dcaOnly") or data.get("dcaPreview") or data.get("dca"))
        combined = summarize(
            data.get("combined")
            or data.get("combinedPreview")
            or data.get("preview")
            or data.get("result")
        )
        # nested summary shapes
        if not combined and isinstance(data.get("combinedPreview"), dict):
            combined = summarize(data["combinedPreview"])
        row = {
            "name": preset["name"],
            "markets": preset["markets"],
            "dcaSettings": preset["dcaSettings"],
            "tsOnly": ts_only,
            "dcaOnly": dca_only,
            "combined": combined,
            "sec": round(time.time() - t0, 1),
            "rawKeys": list(data.keys()),
        }
        results["runs"].append(row)
        print(f"  tsOnly   {ts_only}", flush=True)
        print(f"  dcaOnly  {dca_only}", flush=True)
        print(f"  combined {combined} ({row['sec']}s)", flush=True)
        if ts_only and combined:
            print(
                f"  ΔRet {combined.get('ret', 0) - ts_only.get('ret', 0):+.2f}  "
                f"ΔDD {combined.get('dd', 0) - ts_only.get('dd', 0):+.2f}",
                flush=True,
            )

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(results, f, indent=2, ensure_ascii=False, default=str)
    print(f"\nWrote {OUT}", flush=True)


if __name__ == "__main__":
    main()

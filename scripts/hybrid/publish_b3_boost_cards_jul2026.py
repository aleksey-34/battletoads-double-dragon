#!/usr/bin/env python3
"""Publish 4 new Turbo-style cards from B3 composition + tuned lot/OP/ri/CB.

Does NOT rematerialize live clients onto these cards — only creates master
systems + publishes to offer-store (published list, like Turbo).

  PUBLISH=1 python3 scripts/hybrid/publish_b3_boost_cards_jul2026.py
"""
from __future__ import annotations

import json
import os
import sqlite3
import time
from datetime import datetime, timezone
from typing import Any

import requests

REPO = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
API = os.environ.get("BTDD_API", "http://127.0.0.1:3001")
AUTH_RAW = os.environ.get("ADMIN_SWEEP_TOKEN", "btdd_admin_sweep_2026").strip()
AUTH = AUTH_RAW if AUTH_RAW.lower().startswith("bearer ") else f"Bearer {AUTH_RAW}"
HEADERS = {"Authorization": AUTH, "Content-Type": "application/json"}
DB = os.environ.get("BTDD_DB_PATH", os.path.join(REPO, "backend", "database.db"))
API_KEY = "BTDD_D1"
B3_SYSTEM_ID = 205
DATE_FROM = "2024-06-01"
DATE_TO = os.environ.get("SYNTH_DATE_TO", datetime.now(timezone.utc).date().isoformat())
INITIAL = 10000.0
OUT = os.path.join(REPO, "results", "b3_boost_cards_jul2026.json")

CB_MED = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 8,
    "lotMultiplier": 0.5,
    "pauseDays": 14,
}
CB_L400 = {
    "enabled": True,
    "peakWindowDays": 30,
    "ddTriggerPercent": 12,
    "lotMultiplier": 0.75,
    "pauseDays": 7,
}
CB_OFF = {"enabled": False}

CARDS = [
    {
        "key": "b3_boost_l25",
        "setKey": "synth-stable-b3-boost-l25-jul2026",
        "displayLabel": "Synth Stable B3 Boost L25",
        "lot": 25.0,
        "op": 12,
        "reinvest": 50.0,
        "cb": CB_MED,
        "cbName": "MED",
        "riskProfile": "medium-high",
        "desc": (
            "Тот же набор ног, что у B3, но крупнее лот (25%) при OP12 и мягком CB. "
            "Бьёт Turbo по доходности при умеренной просадке.\n\n"
            "Профиль: ускоренный B3. Риск выше Safe/B3, ниже Nuke-режимов."
        ),
    },
    {
        "key": "b3_boost_l22",
        "setKey": "synth-stable-b3-boost-l22-jul2026",
        "displayLabel": "Synth Stable B3 Boost L22",
        "lot": 22.0,
        "op": 14,
        "reinvest": 75.0,
        "cb": CB_L400,
        "cbName": "L400",
        "riskProfile": "high",
        "desc": (
            "B3-состав + lot22 / OP14 / reinvest75 и CB как у L400. "
            "Сильный разгон относительно Turbo при похожем DD-классе.\n\n"
            "Профиль: агрессивный. Для опытных."
        ),
    },
    {
        "key": "b3_boost_l28",
        "setKey": "synth-stable-b3-boost-l28-jul2026",
        "displayLabel": "Synth Stable B3 Boost L28",
        "lot": 28.0,
        "op": 14,
        "reinvest": 50.0,
        "cb": CB_L400,
        "cbName": "L400",
        "riskProfile": "high",
        "desc": (
            "B3-состав + lot28 / OP14 / ri50, CB L400. "
            "Максимум Ret при DD всё ещё ниже «голого» Nuke.\n\n"
            "Профиль: очень агрессивный."
        ),
    },
    {
        "key": "b3_boost_l32",
        "setKey": "synth-stable-b3-boost-l32-jul2026",
        "displayLabel": "Synth Stable B3 Boost L32 Nuke",
        "lot": 32.0,
        "op": 16,
        "reinvest": 75.0,
        "cb": CB_OFF,
        "cbName": "OFF",
        "riskProfile": "very-high",
        "desc": (
            "B3-состав + lot32 / OP16 / ri75 без circuit breaker. "
            "Сверхразгон: максимальная доходность в сетке, глубокие просадки.\n\n"
            "Профиль: только для очень опытных. CB выключен."
        ),
    },
]


def api_get(path: str) -> dict:
    return requests.get(f"{API}{path}", headers=HEADERS, timeout=120).json()


def api_post(path: str, payload: dict, timeout: int = 1800) -> dict:
    last: Exception | None = None
    for attempt in range(40):
        try:
            r = requests.post(f"{API}{path}", headers=HEADERS, json=payload, timeout=timeout)
            data = r.json()
        except (requests.exceptions.ConnectionError, requests.exceptions.Timeout) as exc:
            last = exc
            time.sleep(8 + attempt)
            continue
        err = str(data.get("error") or "")
        if data.get("success") is False or (err and "result" not in data and path.endswith("/backtest/run")):
            if "already running" in err.lower() and attempt < 39:
                time.sleep(10 + attempt)
                continue
            if err and path.endswith("/backtest/run") and not data.get("result"):
                raise RuntimeError(err)
        if r.status_code >= 400 and not data.get("result") and path.endswith("/backtest/run"):
            raise RuntimeError(f"HTTP {r.status_code}: {err or data}")
        if r.status_code >= 400 and not path.endswith("/backtest/run"):
            raise RuntimeError(f"HTTP {r.status_code}: {err or data}")
        return data
    raise RuntimeError(f"api_post failed: {last}")


def api_patch(path: str, payload: dict) -> dict:
    r = requests.patch(f"{API}{path}", headers=HEADERS, json=payload, timeout=120)
    data = r.json()
    if r.status_code >= 400:
        raise RuntimeError(f"PATCH {path}: {data}")
    return data


def growth_cap(reinvest: float) -> float:
    return min(20.0, 1.0 + (reinvest / 100.0) * 19.0) if reinvest > 0 else 0.0


def metrics_from(result: dict) -> dict:
    s = result.get("summary") or {}
    return {
        "ret": round(float(s.get("totalReturnPercent") or 0), 2),
        "dd": round(float(s.get("maxDrawdownPercent") or 0), 2),
        "pf": round(float(s.get("profitFactor") or 0), 3),
        "trades": int(s.get("tradesCount") or 0),
        "wr": round(float(s.get("winRatePercent") or 0), 1),
        "finalEquity": round(float(s.get("finalEquity") or INITIAL), 2),
    }


def load_b3_members(conn: sqlite3.Connection) -> list[dict]:
    rows = conn.execute(
        """SELECT s.id, s.name, s.strategy_type, s.market_mode, s.base_symbol, s.quote_symbol, s.interval
           FROM trading_system_members m
           JOIN strategies s ON s.id = m.strategy_id
           WHERE m.system_id=? AND COALESCE(m.is_enabled,1)=1
           ORDER BY s.id""",
        (B3_SYSTEM_ID,),
    ).fetchall()
    out = []
    for r in rows:
        base, quote = r[4], r[5]
        market = f"{base}/{quote}" if quote else base
        out.append(
            {
                "strategyId": int(r[0]),
                "strategyName": r[1],
                "strategyType": r[2],
                "marketMode": r[3] or "mono",
                "market": market,
                "interval": r[6],
                "layer": "b3",
            }
        )
    if not out:
        raise SystemExit(f"no members on B3 system {B3_SYSTEM_ID}")
    return out


def run_portfolio(members: list[dict], lot: float, op: int, reinvest: float, cb: dict) -> dict:
    sids = [int(m["strategyId"]) for m in members]
    growth = growth_cap(reinvest)
    payload = {
        "apiKeyName": API_KEY,
        "mode": "portfolio",
        "strategyIds": sids,
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "bars": 9000,
        "warmupBars": 120,
        "initialBalance": INITIAL,
        "commissionPercent": 0.1,
        "slippagePercent": 0.05,
        "maxOpenPositions": op,
        "lotPercentOverride": lot,
        "reinvestPercentOverride": reinvest,
        "maxDepositOverride": INITIAL * growth if growth else 0,
        "lotPercentMultiplierByStrategyId": {str(i): 1.0 for i in sids},
        "enablePairLock": True,
        "skipMissingSymbols": True,
        "portfolioCircuitBreaker": cb,
    }
    data = api_post("/api/backtest/run", payload)
    return metrics_from(data.get("result") or {})


def offer_id(m: dict, set_key: str) -> str:
    return f"b3boost-{set_key}-{int(m['strategyId'])}"


def sync_offers(card: dict, metrics: dict, members: list[dict]) -> list[str]:
    store = api_get("/api/saas/admin/offer-store")
    by_id = {str(o.get("offerId")): o for o in (store.get("offers") or [])}
    offer_ids = []
    patch = []
    per = {
        "ret": round(metrics["ret"] / max(1, len(members)), 1),
        "dd": metrics["dd"],
        "pf": metrics["pf"],
        "trades": int(metrics["trades"] / max(1, len(members))),
    }
    for m in members:
        oid = offer_id(m, card["setKey"])
        offer_ids.append(oid)
        if oid in by_id:
            continue
        sid = int(m["strategyId"])
        preset = {
            "strategyId": sid,
            "strategyName": m["strategyName"],
            "metrics": per,
            "params": {"interval": m.get("interval"), "layer": m.get("layer")},
        }
        patch.append(
            {
                "offerId": oid,
                "titleRu": f"{card['displayLabel']} • {m.get('market')}",
                "descriptionRu": card["desc"],
                "strategy": {
                    "id": sid,
                    "name": m["strategyName"],
                    "type": m["strategyType"],
                    "mode": m["marketMode"],
                    "market": m.get("market"),
                    "params": {"interval": m.get("interval")},
                },
                "metrics": {**per, "score": per.get("ret", 0)},
                "sliderPresets": {"risk": {"medium": preset}, "tradeFrequency": {"medium": preset}},
                "presetMatrix": {"medium": {"medium": preset}},
            }
        )
    if patch:
        api_patch("/api/saas/admin/offer-store", {"offersPatch": patch})
        print(f"  synced {len(patch)} offers")
    return offer_ids


def build_snapshot(card: dict, metrics: dict, offer_ids: list[str], members: list[dict], system_name: str) -> dict:
    d1 = datetime.strptime(DATE_FROM[:10], "%Y-%m-%d").date()
    d2 = datetime.strptime(DATE_TO[:10], "%Y-%m-%d").date()
    period_days = max(1, (d2 - d1).days)
    growth = growth_cap(card["reinvest"])
    return {
        "kind": "algofund-ts",
        "setKey": card["setKey"],
        "displayLabel": card["displayLabel"],
        "storefrontDescription": card["desc"],
        "riskProfile": card["riskProfile"],
        "competitionCard": False,
        "boostCard": True,
        "cardVersion": "b3-boost-jul2026-v1",
        "offerIds": offer_ids,
        "apiKeyName": API_KEY,
        "systemName": system_name,
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "note": f"B3 composition boost; cb={card['cbName']}",
        "exitMode": "close",
        "ret": metrics["ret"],
        "dd": metrics["dd"],
        "pf": metrics["pf"],
        "trades": metrics["trades"],
        "tradesPerDay": round(metrics["trades"] / period_days, 2),
        "periodDays": period_days,
        "initialBalance": INITIAL,
        "finalEquity": metrics["finalEquity"],
        "legs": len(members),
        "backtestSettings": {
            "dateFrom": DATE_FROM,
            "dateTo": DATE_TO,
            "initialBalance": INITIAL,
            "lotPercent": card["lot"],
            "lotPercentOverride": card["lot"],
            "maxOpenPositions": card["op"],
            "reinvestPercent": card["reinvest"],
            "maxDepositOverride": INITIAL * growth if growth else 0,
            "enablePairLock": True,
            "backtestBars": 9000,
            "warmupBars": 120,
            "portfolioCircuitBreaker": card["cb"],
            "lotPercentMultiplierByStrategyId": {str(int(m["strategyId"])): 1.0 for m in members},
        },
    }


def publish_card(card: dict, metrics: dict, members: list[dict]) -> str:
    offer_ids = sync_offers(card, metrics, members)
    draft = [
        {
            "strategyId": int(m["strategyId"]),
            "strategyName": m["strategyName"],
            "strategyType": m["strategyType"],
            "marketMode": m["marketMode"],
            "market": m.get("market"),
            "score": metrics["ret"],
            "weight": round(1.0 / max(1, len(members)), 4),
        }
        for m in members
    ]
    api_post("/api/saas/admin/curated-draft-members", {"members": draft}, timeout=120)
    pub = api_post(
        "/api/saas/admin/publish",
        {
            "offerIds": offer_ids,
            "setKey": card["setKey"],
            "editInPlace": False,
            "cardOverrides": {
                "displayLabel": card["displayLabel"],
                "description": card["desc"],
                "lotPercent": card["lot"],
                "maxOpenPositions": card["op"],
                "reinvestPercent": card["reinvest"],
                "portfolioCircuitBreaker": card["cb"],
            },
        },
        timeout=300,
    )
    system_name = str((pub.get("sourceSystem") or {}).get("systemName") or "").strip()
    if not system_name:
        raise RuntimeError(f"publish failed for {card['setKey']}: {str(pub)[:500]}")
    snapshot = build_snapshot(card, metrics, offer_ids, members, system_name)
    store = api_get("/api/saas/admin/offer-store")
    published = list(store.get("algofundPublishedSystemNames") or [])
    # Keep storefront as-is; add to published like Turbo (optional modules)
    api_patch(
        "/api/saas/admin/offer-store",
        {
            "tsBacktestSnapshotsPatch": {
                card["setKey"]: snapshot,
                system_name: snapshot,
            },
            "algofundPublishedSystemNames": list(dict.fromkeys([*published, system_name])),
        },
    )
    return system_name


def main() -> None:
    do_publish = os.environ.get("PUBLISH", "").strip() in ("1", "true", "yes")
    conn = sqlite3.connect(DB)
    members = load_b3_members(conn)
    print(f"B3 members={len(members)} DATE {DATE_FROM}→{DATE_TO} publish={do_publish}", flush=True)

    out: dict[str, Any] = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "dateFrom": DATE_FROM,
        "dateTo": DATE_TO,
        "memberCount": len(members),
        "cards": {},
    }

    for card in CARDS:
        print(
            f"\n=== {card['displayLabel']} lot={card['lot']} OP={card['op']} "
            f"ri={card['reinvest']} cb={card['cbName']} ===",
            flush=True,
        )
        t0 = time.time()
        metrics = run_portfolio(members, card["lot"], card["op"], card["reinvest"], card["cb"])
        print(f"  BT {metrics} ({time.time() - t0:.0f}s)", flush=True)
        system_name = None
        if do_publish:
            system_name = publish_card(card, metrics, members)
            print(f"  published {system_name}", flush=True)
        out["cards"][card["key"]] = {
            **{k: card[k] for k in ("setKey", "displayLabel", "lot", "op", "reinvest", "cbName", "riskProfile")},
            "metrics": metrics,
            "systemName": system_name,
        }

    os.makedirs(os.path.dirname(OUT) or ".", exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(out, f, indent=2, ensure_ascii=False)
    print(f"\nWrote {OUT}", flush=True)


if __name__ == "__main__":
    main()

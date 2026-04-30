#!/usr/bin/env python3
"""
Super Sweep 2026-04-30: расширенный sweep по всем 3 стратегиям, 3 интервалам,
~25 mono пар + ~12 synth пар. Цель — найти декоррелированный портфель из 8-12
офферов, который превзойдёт текущий aggressive-portfolio MASTER по Sharpe/PF/MaxDD.

Конфиг намеренно "heavy", чтобы покрыть как можно больше комбинаций; engine
сам обрежет по maxRuns и отфильтрует по robust-критериям.
"""
import json
from urllib import request, error

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"

PAYLOAD = {
    "mode": "heavy",
    # WEEX — самый используемый источник; BTDD_D1 — стабильный ключ
    "apiKeyName": "BTDD_D1",
    "dateFrom": "2025-04-01T00:00:00Z",
    "dateTo": None,
    # NB: don't send `interval` (string) — buildDefaultConfig prefers it over `intervals`
    "intervals": ["1h", "4h", "12h"],

    # Anchors + текущие активные + расширение mid/large cap
    "monoMarkets": [
        # Anchors (large cap / liquid)
        "BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT", "XRPUSDT",
        # Текущие active (из mastera + sweep history)
        "BERAUSDT", "IPUSDT", "ORDIUSDT", "GRTUSDT", "INJUSDT",
        "TRUUSDT", "STXUSDT", "VETUSDT", "AUCTIONUSDT", "MERLUSDT",
        "ZECUSDT", "SOMIUSDT", "OPUSDT", "FETUSDT", "SEIUSDT",
        # Новые кандидаты (ликвидные альты разных секторов)
        "AVAXUSDT", "LINKUSDT", "ARBUSDT", "SUIUSDT", "TONUSDT",
        "WLDUSDT", "NEARUSDT", "ONDOUSDT", "TIAUSDT", "DOGEUSDT",
    ],

    # Synth (cross-sector / cross-cap пары для stat_arb_zscore)
    "synthMarkets": [
        "ETHUSDT/BTCUSDT", "SOLUSDT/ETHUSDT", "BNBUSDT/BTCUSDT",
        "ARBUSDT/OPUSDT", "SUIUSDT/SEIUSDT", "TIAUSDT/SEIUSDT",
        "ONDOUSDT/TIAUSDT", "LINKUSDT/UNIUSDT" if False else "INJUSDT/GRTUSDT",
        "FETUSDT/OPUSDT", "TRUUSDT/GRTUSDT", "IPUSDT/ZECUSDT",
        "ORDIUSDT/ZECUSDT", "BERAUSDT/IPUSDT", "AUCTIONUSDT/MERLUSDT",
    ],

    "strategyTypes": ["DD_BattleToads", "stat_arb_zscore", "zz_breakout"],

    # DD_BattleToads grid
    "ddLengths": [5, 8, 12, 16, 24, 36],
    "ddTakeProfits": [2, 3, 5, 7.5, 10],
    "ddSources": ["close", "wick"],

    # stat_arb_zscore grid
    "statLengths": [24, 36, 48, 72, 96, 120],
    "statEntry": [1.5, 1.75, 2.0, 2.25],
    "statExit": [0.5, 0.75, 1.0],
    "statStop": [2.5, 3.0, 3.5],

    # Engine params
    "backtestBars": 6000,
    "warmupBars": 200,
    "initialBalance": 10000,
    "commissionPercent": 0.1,
    "slippagePercent": 0.05,
    "fundingRatePercent": 0,
    "skipMissingSymbols": True,

    # Robust filter (немного строже базового, чтобы отсеять шум)
    "robust": {
        "minProfitFactor": 1.20,
        "maxDrawdownPercent": 22,
        "minTrades": 40,
    },

    # Control
    "exhaustiveMode": False,
    "turboMode": True,
    "resumeEnabled": True,
    "checkpointEvery": 25,
    "maxRuns": 1500,
    "maxVariantsPerMarketType": 60,
    "allowDuplicateMarkets": False,
    "updateExistingStrategies": False,
    "windowBacktestsEnabled": False,
    "maxMembers": 24,

    # Output identifiers
    "strategyPrefix": "SUPERSWEEP_20260430",
    "systemName": "SuperSweep 2026-04-30",
}


def main():
    req = request.Request(
        f"{API_BASE}/api/research/sweeps/full-historical/start",
        data=json.dumps(PAYLOAD).encode("utf-8"),
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {ADMIN_TOKEN}",
        },
        method="POST",
    )
    try:
        with request.urlopen(req, timeout=120) as resp:
            print(resp.read().decode("utf-8"))
    except error.HTTPError as exc:
        print(json.dumps({"httpError": exc.code, "body": exc.read().decode("utf-8")}, ensure_ascii=False))


if __name__ == "__main__":
    main()

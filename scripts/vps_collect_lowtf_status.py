#!/usr/bin/env python3
import json
from pathlib import Path
from urllib import request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"
RESULTS_DIR = Path("/opt/battletoads-double-dragon/results")
QUEUE_LOG = Path("/opt/battletoads-double-dragon/logs/lower_tf_queue.log")
CATALOGS = [
    ("mexc", "btdd_mex_research_client_catalog_2026-04-17T13-27-03-404Z.json"),
    ("bitget", "hdb_17_client_catalog_2026-04-17T14-25-14-791Z.json"),
    ("bingx", "hdb_15_client_catalog_2026-04-17T14-28-04-998Z.json"),
    ("bingx", "hdb_18_client_catalog_2026-04-17T14-31-04-937Z.json"),
    ("weex", "ivan_weex_research_client_catalog_2026-04-17T14-32-21-645Z.json"),
]


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=60) as resp:
        return json.loads(resp.read().decode("utf-8"))


def parse_title_bits(title: str):
    parts = [part.strip() for part in str(title or "").split("•")]
    mode = parts[0].lower() if len(parts) > 0 else ""
    strategy = parts[1] if len(parts) > 1 else ""
    market = parts[2] if len(parts) > 2 else ""
    return mode, strategy, market


def infer_role(ret_per_30d: float, trades_per_30d: float, pf: float, dd: float):
    if pf >= 1.05 and ret_per_30d > 0.75 and trades_per_30d >= 20 and dd <= 12:
        return "storefront_candidate"
    if pf >= 1.0 and ret_per_30d > 0.25 and trades_per_30d >= 12 and dd <= 18:
        return "ts_candidate_core"
    if pf >= 0.97 and ret_per_30d > 0 and trades_per_30d >= 8 and dd <= 22:
        return "ts_candidate_satellite"
    if trades_per_30d >= 8:
        return "analytics_only"
    return "reject"


def build_summary_rows():
    rows = []
    for exchange, file_name in CATALOGS:
        path = RESULTS_DIR / file_name
        if not path.exists():
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        client_catalog = payload.get("clientCatalog") or {}
        for bucket in ("mono", "synth"):
            for item in client_catalog.get(bucket) or []:
                metrics = item.get("metrics") or {}
                period_days = float(metrics.get("periodDays") or item.get("periodDays") or 0)
                ret = float(metrics.get("ret") or item.get("ret") or 0)
                trades = float(metrics.get("trades") or item.get("trades") or 0)
                pf = float(metrics.get("pf") or item.get("pf") or 0)
                dd = float(metrics.get("dd") or item.get("dd") or 0)
                title = str(item.get("titleRu") or item.get("title") or "")
                parsed_mode, parsed_strategy, parsed_market = parse_title_bits(title)
                tf = ((item.get("strategyParams") or {}).get("interval")) or item.get("familyInterval") or item.get("interval")
                ret_per_30d = round(ret / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(ret, 3)
                trades_per_30d = round(trades / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(trades, 3)
                rows.append({
                    "exchange": exchange,
                    "offerId": item.get("offerId"),
                    "titleRu": title,
                    "market": item.get("market") or parsed_market,
                    "mode": item.get("mode") or parsed_mode or bucket,
                    "strategyType": item.get("strategyType") or parsed_strategy,
                    "tf": tf,
                    "retPer30d": ret_per_30d,
                    "tradesPer30d": trades_per_30d,
                    "pf": round(pf, 3),
                    "dd": round(dd, 3),
                    "roleSuggestion": infer_role(ret_per_30d, trades_per_30d, pf, dd),
                })
    rows.sort(key=lambda row: (-row["retPer30d"], -row["tradesPer30d"], -row["pf"], row["exchange"], str(row["offerId"] or "")))
    return rows


def main():
    status = api_get("/api/research/sweeps/full-historical/status")
    artifacts = sorted(
        [p.name for p in RESULTS_DIR.glob("*historical_sweep_2026-04-17*.json")]
        + [p.name for p in RESULTS_DIR.glob("*client_catalog_2026-04-17*.json")]
    )
    queue_tail = []
    if QUEUE_LOG.exists():
        queue_tail = QUEUE_LOG.read_text(encoding="utf-8", errors="ignore").splitlines()[-20:]
    summary_rows = build_summary_rows()
    by_exchange = {}
    by_role = {}
    for row in summary_rows:
        by_exchange[row["exchange"]] = by_exchange.get(row["exchange"], 0) + 1
        by_role[row["roleSuggestion"]] = by_role.get(row["roleSuggestion"], 0) + 1
    print(
        json.dumps(
            {
                "status": status,
                "artifacts": artifacts,
                "queueTail": queue_tail,
                "baseSummary": {
                    "total": len(summary_rows),
                    "byExchange": by_exchange,
                    "byRole": by_role,
                    "top10": summary_rows[:10],
                    "storefrontBase": [row for row in summary_rows if row["roleSuggestion"] == "storefront_candidate"][:10],
                    "tsAssemblyPool": [row for row in summary_rows if row["roleSuggestion"] in {"ts_candidate_core", "ts_candidate_satellite"}][:15],
                },
            },
            ensure_ascii=False,
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
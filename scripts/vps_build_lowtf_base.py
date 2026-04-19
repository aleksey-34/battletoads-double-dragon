#!/usr/bin/env python3
import json
from pathlib import Path
from collections import defaultdict

RESULTS_DIR = Path("/opt/battletoads-double-dragon/results")

CATALOGS = [
    ("mexc", "btdd_mex_research_client_catalog_2026-04-17T13-27-03-404Z.json"),
    ("bitget", "hdb_17_client_catalog_2026-04-17T14-25-14-791Z.json"),
    ("bingx", "hdb_15_client_catalog_2026-04-17T14-28-04-998Z.json"),
    ("bingx", "hdb_18_client_catalog_2026-04-17T14-31-04-937Z.json"),
    ("weex", "ivan_weex_research_client_catalog_2026-04-17T14-32-21-645Z.json"),
]

PROMOTION_PATTERNS = [
    ("weex", "ivan_weex_research_client_catalog_2026-04-17T*.json"),
    ("bitget", "hdb_17_client_catalog_2026-04-17T*.json"),
]

PROMOTION_CHECKPOINT_MARKERS = {
    "weex": "lowtf_promo_weex_promotion_checkpoint.json",
    "bitget": "lowtf_promo_bitget_promotion_checkpoint.json",
}


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


def normalize_row(exchange: str, item: dict, bucket: str, layer: str, source_file: str):
    metrics = item.get("metrics") or {}
    period_days = float(metrics.get("periodDays") or item.get("periodDays") or 0)
    ret = float(metrics.get("ret") or item.get("ret") or 0)
    trades = float(metrics.get("trades") or item.get("trades") or 0)
    pf = float(metrics.get("pf") or item.get("pf") or 0)
    dd = float(metrics.get("dd") or item.get("dd") or 0)
    tf = (
        ((item.get("strategyParams") or {}).get("interval"))
        or item.get("familyInterval")
        or item.get("interval")
        or ((item.get("strategy") or {}).get("interval"))
    )
    title = str(item.get("titleRu") or item.get("title") or "")
    parsed_mode, parsed_strategy, parsed_market = parse_title_bits(title)
    strategy_type = (
        ((item.get("strategy") or {}).get("type"))
        or item.get("strategyType")
        or parsed_strategy
    )
    market = item.get("market") or ((item.get("strategy") or {}).get("market")) or parsed_market
    mode = item.get("mode") or ((item.get("strategy") or {}).get("mode")) or parsed_mode or bucket
    ret_per_30d = round(ret / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(ret, 3)
    trades_per_30d = round(trades / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(trades, 3)
    role = infer_role(ret_per_30d, trades_per_30d, pf, dd)
    return {
        "layer": layer,
        "sourceFile": source_file,
        "exchange": exchange,
        "offerId": item.get("offerId"),
        "titleRu": title,
        "market": market,
        "mode": mode,
        "strategyType": strategy_type,
        "tf": tf,
        "periodDays": period_days,
        "ret": round(ret, 3),
        "retPer30d": ret_per_30d,
        "trades": round(trades, 3),
        "tradesPer30d": trades_per_30d,
        "pf": round(pf, 3),
        "dd": round(dd, 3),
        "roleSuggestion": role,
    }


def load_catalog_rows(catalogs, layer):
    rows = []
    missing = []
    for exchange, file_name in catalogs:
        path = RESULTS_DIR / file_name
        if not path.exists():
            missing.append(file_name)
            continue
        payload = json.loads(path.read_text(encoding="utf-8"))
        client_catalog = payload.get("clientCatalog") or {}
        for bucket in ("mono", "synth"):
            for item in client_catalog.get(bucket) or []:
                rows.append(normalize_row(exchange, item, bucket, layer, file_name))
    return rows, missing


def load_catalog_payload(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def is_honest_promotion_catalog(exchange: str, payload: dict):
    config = payload.get("config") or {}
    checkpoint_file = str(config.get("checkpointFile") or "")
    expected_checkpoint = PROMOTION_CHECKPOINT_MARKERS.get(exchange, "")
    return (
        config.get("resumeEnabled") is False
        and config.get("maxMembers") == 1
        and expected_checkpoint
        and checkpoint_file.endswith(expected_checkpoint)
    )


def resolve_latest_catalogs(patterns):
    resolved = []
    missing = []
    for exchange, pattern in patterns:
        matches = sorted(RESULTS_DIR.glob(pattern))
        if exchange == "weex":
            matches = [path for path in matches if "ivan_weex_research_client_catalog_" in path.name]
        elif exchange == "bitget":
            matches = [path for path in matches if "hdb_17_client_catalog_" in path.name]
        if not matches:
            missing.append(pattern)
            continue
        honest_matches = []
        for path in matches:
            try:
                payload = load_catalog_payload(path)
            except Exception:
                continue
            if is_honest_promotion_catalog(exchange, payload):
                honest_matches.append(path)
        if honest_matches:
            resolved.append((exchange, honest_matches[-1].name))
        else:
            missing.append(f"honest:{exchange}:{pattern}")
    return resolved, missing


def main():
    baseline_rows, missing_baseline = load_catalog_rows(CATALOGS, "baseline")
    promotion_catalogs, missing_promotion_patterns = resolve_latest_catalogs(PROMOTION_PATTERNS)
    promotion_rows, missing_promotion_catalogs = load_catalog_rows(promotion_catalogs, "promotion")
    rows = baseline_rows + promotion_rows
    missing = {
        "baseline": missing_baseline,
        "promotionPatterns": missing_promotion_patterns,
        "promotionCatalogs": missing_promotion_catalogs,
    }

    rows.sort(key=lambda row: (-row["retPer30d"], -row["tradesPer30d"], -row["pf"], row["exchange"], str(row["offerId"] or "")))
    by_exchange = {}
    by_role = {}
    for row in rows:
        by_exchange[row["exchange"]] = by_exchange.get(row["exchange"], 0) + 1
        by_role[row["roleSuggestion"]] = by_role.get(row["roleSuggestion"], 0) + 1

    def summarize(group_key, source_rows=None):
        source_rows = source_rows if source_rows is not None else rows
        grouped = defaultdict(list)
        for row in source_rows:
            grouped[row[group_key]].append(row)
        summary = []
        for key, items in grouped.items():
            count = len(items)
            summary.append(
                {
                    "key": key,
                    "count": count,
                    "avgRet": round(sum(item["ret"] for item in items) / count, 3),
                    "avgRetPer30d": round(sum(item["retPer30d"] for item in items) / count, 3),
                    "avgPf": round(sum(item["pf"] for item in items) / count, 3),
                    "avgDd": round(sum(item["dd"] for item in items) / count, 3),
                    "avgTrades": round(sum(item["trades"] for item in items) / count, 3),
                    "avgTradesPer30d": round(sum(item["tradesPer30d"] for item in items) / count, 3),
                }
            )
        summary.sort(key=lambda item: (-item["avgRetPer30d"], -item["avgPf"], item["avgDd"], str(item["key"])))
        return summary

    failure_reasons = {
        "pf_below_1": 0,
        "negative_ret": 0,
        "low_trade_count": 0,
        "high_drawdown_gt_1": 0,
        "high_drawdown_gt_5": 0,
    }
    for row in rows:
        if row["pf"] < 1:
            failure_reasons["pf_below_1"] += 1
        if row["retPer30d"] <= 0:
            failure_reasons["negative_ret"] += 1
        if row["tradesPer30d"] < 25:
            failure_reasons["low_trade_count"] += 1
        if row["dd"] > 1:
            failure_reasons["high_drawdown_gt_1"] += 1
        if row["dd"] > 5:
            failure_reasons["high_drawdown_gt_5"] += 1

    promotion_candidates = [
        row
        for row in sorted(baseline_rows, key=lambda item: (abs(item["retPer30d"]), -item["pf"], item["dd"], -item["tradesPer30d"]))
        if row["strategyType"] == "stat_arb_zscore" and row["market"] == "OPUSDT"
    ][:8]

    promotion_verdict = {
        "rowCount": len(promotion_rows),
        "allNegative": all(row["retPer30d"] <= 0 for row in promotion_rows) if promotion_rows else True,
        "allPfBelow1": all(row["pf"] < 1 for row in promotion_rows) if promotion_rows else True,
        "bestRetPer30d": max((row["retPer30d"] for row in promotion_rows), default=None),
        "bestPf": max((row["pf"] for row in promotion_rows), default=None),
        "looksReplayedFromCheckpoint": bool(promotion_rows) and sorted(
            (row["exchange"], row["titleRu"], row["retPer30d"], row["pf"], row["dd"], row["tradesPer30d"])
            for row in promotion_rows
        ) == sorted(
            (row["exchange"], row["titleRu"], row["retPer30d"], row["pf"], row["dd"], row["tradesPer30d"])
            for row in baseline_rows
            if row["exchange"] in {"weex", "bitget"}
        ),
    }

    promotion_guardrails = {
        "preferVenues": ["weex", "bitget"],
        "deprioritizeVenues": ["mexc", "bingx"],
        "preferLengths": [72, 96],
        "avoidLengths": [24, 120],
        "preferZscoreExit": [1, 0.75],
        "avoidZscoreExit": [0.5],
        "note": "Current baseline suggests narrowing toward least-negative OPUSDT stat-arb zones before any broader promotion sweep.",
    }

    result = {
        "missingCatalogs": missing,
        "counts": {
            "total": len(rows),
            "baselineTotal": len(baseline_rows),
            "promotionTotal": len(promotion_rows),
            "byExchange": by_exchange,
            "byRole": by_role,
        },
        "top20": rows[:20],
        "layers": {
            "baselineTop10": baseline_rows[:10],
            "promotionTop10": sorted(
                promotion_rows,
                key=lambda row: (-row["retPer30d"], -row["pf"], row["dd"], -row["tradesPer30d"]),
            )[:10],
        },
        "storefrontBase": [row for row in rows if row["roleSuggestion"] == "storefront_candidate"][:20],
        "tsAssemblyPool": [row for row in rows if row["roleSuggestion"] in {"ts_candidate_core", "ts_candidate_satellite"}][:30],
        "analyticsOnly": [row for row in rows if row["roleSuggestion"] == "analytics_only"][:20],
        "segmentation": {
            "failureReasons": failure_reasons,
            "byStrategyType": summarize("strategyType"),
            "byExchange": summarize("exchange"),
            "byMarket": summarize("market"),
            "byMode": summarize("mode"),
            "byTf": summarize("tf"),
            "baselineByExchange": summarize("exchange", baseline_rows),
            "promotionByExchange": summarize("exchange", promotion_rows),
        },
        "promotionResweep": {
            "resolvedCatalogs": promotion_catalogs,
            "guardrails": promotion_guardrails,
            "candidates": promotion_candidates,
            "verdict": promotion_verdict,
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
#!/usr/bin/env python3
import json
from collections import defaultdict
from pathlib import Path

RESULTS_DIR = Path("/opt/battletoads-double-dragon/results")

ANCHOR_PATTERNS = [
    ("mexc", "*client_catalog_*.json"),
    ("bitget", "*client_catalog_*.json"),
]

ANCHOR_PREFIX_MARKERS = {
    "mexc": {"ANCHOR_MEXC", "ANCHORX_MEXC", "ANCHORG_MEXC"},
    "bitget": {"ANCHOR_BITGET", "ANCHORX_BITGET", "ANCHORG_BITGET"},
}

ANCHOR_CHECKPOINT_MARKERS = {
    "mexc": {
        "anchor_mexc_anchor_checkpoint.json",
        "anchorx_mexc_anchor_expansion_checkpoint.json",
        "anchorg_mexc_anchor_growth_checkpoint.json",
    },
    "bitget": {
        "anchor_bitget_anchor_checkpoint.json",
        "anchorx_bitget_anchor_expansion_checkpoint.json",
        "anchorg_bitget_anchor_growth_checkpoint.json",
    },
}


def infer_anchor_role(ret_per_30d: float, trades_per_30d: float, pf: float, dd: float, tf: str):
    if tf in {"1h", "4h"} and pf >= 1.08 and ret_per_30d > 0.2 and trades_per_30d >= 4 and dd <= 0.35:
        return "anchor_core"
    if tf in {"1h", "4h"} and pf >= 1.0 and ret_per_30d > 0 and trades_per_30d >= 3 and dd <= 0.45:
        return "anchor_candidate"
    if trades_per_30d >= 2:
        return "telemetry_only"
    return "reject"


def infer_risk_tier(pf: float, dd: float, tf: str):
    if tf in {"1h", "4h"} and pf >= 1.15 and dd <= 0.15:
        return "vitrine_core"
    if tf in {"1h", "4h"} and pf >= 1.05 and dd <= 0.35:
        return "growth"
    return "speculative"


def to_percent(value: float):
    return round(float(value) * 100.0, 1)


def parse_title_bits(title: str):
    parts = [part.strip() for part in str(title or "").split("•")]
    mode = parts[0].lower() if len(parts) > 0 else ""
    strategy = parts[1] if len(parts) > 1 else ""
    market = parts[2] if len(parts) > 2 else ""
    return mode, strategy, market


def load_payload(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def is_anchor_catalog(exchange: str, payload: dict):
    config = payload.get("config") or {}
    strategy_prefix = str(config.get("strategyPrefix") or "")
    checkpoint_file = str(config.get("checkpointFile") or "")
    prefixes = ANCHOR_PREFIX_MARKERS.get(exchange, set())
    checkpoints = ANCHOR_CHECKPOINT_MARKERS.get(exchange, set())
    return (
        config.get("resumeEnabled") is False
        and config.get("maxMembers") == 4
        and strategy_prefix in prefixes
        and any(checkpoint_file.endswith(marker) for marker in checkpoints)
    )


def resolve_latest_catalogs():
    resolved = []
    for exchange, pattern in ANCHOR_PATTERNS:
        matches = sorted(RESULTS_DIR.glob(pattern))
        anchor_matches = []
        for path in matches:
            try:
                payload = load_payload(path)
            except Exception:
                continue
            if is_anchor_catalog(exchange, payload):
                anchor_matches.append((path, payload))
        grouped = {}
        for path, payload in anchor_matches:
            config = payload.get("config") or {}
            strategy_prefix = str(config.get("strategyPrefix") or "")
            grouped[strategy_prefix] = path
        for strategy_prefix, path in sorted(grouped.items()):
            resolved.append((exchange, strategy_prefix, path))
    return resolved


def load_rows():
    rows = []
    resolved = resolve_latest_catalogs()
    for exchange, strategy_prefix, path in resolved:
        payload = load_payload(path)
        for bucket in ("mono", "synth"):
            for item in ((payload.get("clientCatalog") or {}).get(bucket) or []):
                metrics = item.get("metrics") or {}
                period_days = float(metrics.get("periodDays") or item.get("periodDays") or 0)
                ret = float(metrics.get("ret") or item.get("ret") or 0)
                trades = float(metrics.get("trades") or item.get("trades") or 0)
                pf = float(metrics.get("pf") or item.get("pf") or 0)
                dd = float(metrics.get("dd") or item.get("dd") or 0)
                tf = (
                    ((item.get("strategyParams") or {}).get("interval"))
                    or ((item.get("strategy") or {}).get("params") or {}).get("interval")
                    or item.get("familyInterval")
                    or item.get("interval")
                    or ((item.get("strategy") or {}).get("interval"))
                    or ""
                )
                title = str(item.get("titleRu") or item.get("title") or "")
                mode, strategy_type, market = parse_title_bits(title)
                ret_per_30d = round(ret / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(ret, 3)
                trades_per_30d = round(trades / max(1.0, period_days / 30.0), 3) if period_days > 0 else round(trades, 3)
                rows.append({
                    "exchange": exchange,
                    "strategyPrefix": strategy_prefix,
                    "sourceFile": path.name,
                    "offerId": item.get("offerId"),
                    "titleRu": title,
                    "market": item.get("market") or market,
                    "mode": item.get("mode") or mode or bucket,
                    "strategyType": ((item.get("strategy") or {}).get("type")) or item.get("strategyType") or strategy_type,
                    "tf": tf,
                    "ret": round(ret, 3),
                    "retPercent": to_percent(ret),
                    "retPer30d": ret_per_30d,
                    "retPer30dPercent": to_percent(ret_per_30d),
                    "trades": round(trades, 3),
                    "tradesPer30d": trades_per_30d,
                    "pf": round(pf, 3),
                    "dd": round(dd, 3),
                    "ddPercent": to_percent(dd),
                    "roleSuggestion": infer_anchor_role(ret_per_30d, trades_per_30d, pf, dd, str(tf)),
                    "riskTier": infer_risk_tier(pf, dd, str(tf)),
                })
    rows.sort(key=lambda row: (-row["retPer30d"], -row["pf"], row["dd"], -row["tradesPer30d"]))
    return rows, resolved


def summarize(rows, key):
    grouped = defaultdict(list)
    for row in rows:
        grouped[row[key]].append(row)
    result = []
    for item_key, items in grouped.items():
        count = len(items)
        result.append({
            "key": item_key,
            "count": count,
            "avgRetPer30d": round(sum(item["retPer30d"] for item in items) / count, 3),
            "avgRetPer30dPercent": to_percent(sum(item["retPer30d"] for item in items) / count),
            "avgPf": round(sum(item["pf"] for item in items) / count, 3),
            "avgDd": round(sum(item["dd"] for item in items) / count, 3),
            "avgDdPercent": to_percent(sum(item["dd"] for item in items) / count),
            "avgTradesPer30d": round(sum(item["tradesPer30d"] for item in items) / count, 3),
        })
    result.sort(key=lambda item: (-item["avgRetPer30d"], -item["avgPf"], item["avgDd"]))
    return result


def build_ts_shortlist(rows):
    priority = {
        "DD_BattleToads": 0,
        "zz_breakout": 1,
    }
    anchor_core = [row for row in rows if row["roleSuggestion"] == "anchor_core"]
    anchor_core.sort(
        key=lambda row: (
            row["exchange"],
            row["market"],
            row["tf"],
            priority.get(row["strategyType"], 99),
            -row["retPer30d"],
            -row["pf"],
            row["dd"],
        )
    )
    seen = set()
    shortlist = []
    for row in anchor_core:
        key = (row["exchange"], row["market"], row["tf"])
        if key in seen:
            continue
        seen.add(key)
        shortlist.append(row)
    reserve = [row for row in rows if row["roleSuggestion"] == "anchor_candidate"]
    reserve.sort(key=lambda row: (-row["retPer30d"], -row["pf"], row["dd"], -row["tradesPer30d"]))
    return shortlist, reserve


def build_ts_packs(rows):
    deduped_core, reserve = build_ts_shortlist(rows)
    vitrine_core = [row for row in deduped_core if row["riskTier"] == "vitrine_core"]
    growth = [row for row in deduped_core if row["riskTier"] == "growth"]
    speculative = [row for row in deduped_core if row["riskTier"] == "speculative"]
    return {
        "vitrineCore": vitrine_core[:20],
        "growth": growth[:20],
        "speculative": speculative[:20],
        "reserve": reserve[:20],
    }


def main():
    rows, resolved = load_rows()
    ts_shortlist, reserve_candidates = build_ts_shortlist(rows)
    ts_packs = build_ts_packs(rows)
    by_role = defaultdict(int)
    by_exchange = defaultdict(int)
    by_risk_tier = defaultdict(int)
    for row in rows:
        by_role[row["roleSuggestion"]] += 1
        by_exchange[row["exchange"]] += 1
        by_risk_tier[row["riskTier"]] += 1
    result = {
        "resolvedCatalogs": [
            {"exchange": exchange, "strategyPrefix": strategy_prefix, "file": path.name}
            for exchange, strategy_prefix, path in resolved
        ],
        "counts": {
            "total": len(rows),
            "byRole": dict(by_role),
            "byExchange": dict(by_exchange),
            "byRiskTier": dict(by_risk_tier),
        },
        "top20": rows[:20],
        "anchorCore": [row for row in rows if row["roleSuggestion"] == "anchor_core"][:20],
        "anchorCandidates": [row for row in rows if row["roleSuggestion"] == "anchor_candidate"][:20],
        "telemetryOnly": [row for row in rows if row["roleSuggestion"] == "telemetry_only"][:20],
        "tsShortlist": ts_shortlist[:20],
        "reserveCandidates": reserve_candidates[:20],
        "tsPacks": ts_packs,
        "segmentation": {
            "byTf": summarize(rows, "tf"),
            "byStrategyType": summarize(rows, "strategyType"),
            "byExchange": summarize(rows, "exchange"),
            "byMode": summarize(rows, "mode"),
        },
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
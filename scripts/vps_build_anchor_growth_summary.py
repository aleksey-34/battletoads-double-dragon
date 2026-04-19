#!/usr/bin/env python3
import json
from collections import defaultdict
from pathlib import Path

RESULTS_DIR = Path("/opt/battletoads-double-dragon/results")
PREFIXES = {"ANCHORG_MEXC", "ANCHORG_BITGET"}
CHECKPOINT_MARKERS = {
    "anchorg_mexc_anchor_growth_checkpoint.json",
    "anchorg_bitget_anchor_growth_checkpoint.json",
}


def to_percent(value: float):
    return round(float(value) * 100.0, 1)


def infer_role(ret_per_30d: float, trades_per_30d: float, pf: float, dd: float, tf: str):
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


def load_payload(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def resolve_growth_catalogs():
    result = []
    for path in sorted(RESULTS_DIR.glob("*client_catalog_*.json")):
        try:
            payload = load_payload(path)
        except Exception:
            continue
        config = payload.get("config") or {}
        prefix = str(config.get("strategyPrefix") or "")
        checkpoint = str(config.get("checkpointFile") or "")
        if prefix in PREFIXES and any(checkpoint.endswith(marker) for marker in CHECKPOINT_MARKERS):
            result.append((prefix, path, payload))
    latest = {}
    for prefix, path, payload in result:
        latest[prefix] = (path, payload)
    return [(prefix, latest[prefix][0], latest[prefix][1]) for prefix in sorted(latest.keys())]


def parse_title_bits(title: str):
    parts = [part.strip() for part in str(title or "").split("•")]
    mode = parts[0].lower() if len(parts) > 0 else ""
    strategy = parts[1] if len(parts) > 1 else ""
    market = parts[2] if len(parts) > 2 else ""
    return mode, strategy, market


def load_rows():
    rows = []
    catalogs = resolve_growth_catalogs()
    for prefix, path, payload in catalogs:
        exchange = "mexc" if "MEXC" in prefix else "bitget"
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
                    "strategyPrefix": prefix,
                    "sourceFile": path.name,
                    "offerId": item.get("offerId"),
                    "titleRu": title,
                    "market": item.get("market") or market,
                    "mode": item.get("mode") or mode or bucket,
                    "strategyType": ((item.get("strategy") or {}).get("type")) or item.get("strategyType") or strategy_type,
                    "tf": tf,
                    "retPercent": to_percent(ret),
                    "retPer30dPercent": to_percent(ret_per_30d),
                    "tradesPer30d": trades_per_30d,
                    "pf": round(pf, 3),
                    "ddPercent": to_percent(dd),
                    "roleSuggestion": infer_role(ret_per_30d, trades_per_30d, pf, dd, str(tf)),
                    "riskTier": infer_risk_tier(pf, dd, str(tf)),
                })
    rows.sort(key=lambda row: (-row["retPer30dPercent"], -row["pf"], row["ddPercent"], -row["tradesPer30d"]))
    return rows, catalogs


def build_ts_packs(rows):
    deduped = []
    seen = set()
    priority = {"DD_BattleToads": 0, "zz_breakout": 1, "stat_arb_zscore": 2}
    anchorish = [r for r in rows if r["roleSuggestion"] in {"anchor_core", "anchor_candidate"}]
    anchorish.sort(key=lambda row: (row["exchange"], row["market"], row["tf"], priority.get(row["strategyType"], 9), -row["retPer30dPercent"], -row["pf"], row["ddPercent"]))
    for row in anchorish:
        key = (row["exchange"], row["market"], row["tf"])
        if key in seen:
            continue
        seen.add(key)
        deduped.append(row)
    return {
        "vitrineCore": [row for row in deduped if row["riskTier"] == "vitrine_core"][:20],
        "growth": [row for row in deduped if row["riskTier"] == "growth"][:20],
        "speculative": [row for row in deduped if row["riskTier"] == "speculative"][:20],
    }


def main():
    rows, catalogs = load_rows()
    counts = defaultdict(int)
    for row in rows:
        counts[row["roleSuggestion"]] += 1
    result = {
        "resolvedCatalogs": [{"strategyPrefix": prefix, "file": path.name} for prefix, path, _ in catalogs],
        "counts": {"total": len(rows), "byRole": dict(counts)},
        "topRows": rows[:12],
        "tsPacks": build_ts_packs(rows),
    }
    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
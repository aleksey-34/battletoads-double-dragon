#!/usr/bin/env python3
import json
import sqlite3
from collections import defaultdict
from datetime import datetime, timezone

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
TS_KEY = "offer.store.ts_backtest_snapshots"
REVIEW_KEY = "offer.store.review_snapshots"

HF_KEY = "ALGOFUND_MASTER::BTDD_D1::high-freq"
VP_KEY = "ALGOFUND_MASTER::BTDD_D1::volume-pulse-v1"


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def load_flag(cur: sqlite3.Cursor, key: str) -> dict:
    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key = ?", (key,)).fetchone()
    if not row:
        return {}
    try:
        data = json.loads(row["value"] or "{}")
    except Exception:
        return {}
    return data if isinstance(data, dict) else {}


def avg(values):
    cleaned = [float(v) for v in values if v is not None]
    return sum(cleaned) / len(cleaned) if cleaned else 0.0


def aggregate_equity_points(metrics: list, fallback_final_equity: float) -> list:
    series = []
    for m in metrics:
        points = m.get("equityPoints")
        if isinstance(points, list) and len(points) >= 2:
            cleaned = []
            for p in points:
                try:
                    cleaned.append(float(p))
                except Exception:
                    pass
            if len(cleaned) >= 2:
                series.append(cleaned)

    if not series:
        return [round(10000.0 + (fallback_final_equity - 10000.0) * i / 99, 2) for i in range(100)]

    target_len = max(len(s) for s in series)

    def resample(src: list, n: int) -> list:
        if len(src) == n:
            return src
        if n <= 1 or len(src) <= 1:
            return [src[0] if src else 10000.0] * max(n, 1)
        out = []
        span = len(src) - 1
        for i in range(n):
            pos = i * span / (n - 1)
            left = int(pos)
            right = min(left + 1, len(src) - 1)
            frac = pos - left
            out.append(src[left] * (1.0 - frac) + src[right] * frac)
        return out

    normalized = []
    for s in series:
        base = s[0] if s and abs(s[0]) > 1e-9 else 10000.0
        scale = 10000.0 / base
        scaled = [v * scale for v in s]
        normalized.append(resample(scaled, target_len))

    merged = []
    for i in range(target_len):
        merged.append(sum(s[i] for s in normalized) / len(normalized))

    if target_len != 100:
        merged = resample(merged, 100)

    if merged:
        start = merged[0] if abs(merged[0]) > 1e-9 else 10000.0
        desired_start = 10000.0
        desired_end = float(fallback_final_equity)
        src_span = merged[-1] - start
        dst_span = desired_end - desired_start
        if abs(src_span) > 1e-9:
            scale = dst_span / src_span
            merged = [desired_start + (v - start) * scale for v in merged]
        else:
            merged = [desired_start + dst_span * i / max(1, len(merged) - 1) for i in range(len(merged))]
        merged[0] = desired_start
        merged[-1] = desired_end

    return [round(v, 2) for v in merged]


def resolve_win_rate(metrics: list) -> float:
    direct = [m.get("winRate") for m in metrics if m.get("winRate") is not None]
    if direct:
        return round(avg(direct), 2)

    alt = [m.get("winRatePercent") for m in metrics if m.get("winRatePercent") is not None]
    if alt:
        return round(avg(alt), 2)

    wins = 0.0
    trades_total = 0.0
    for m in metrics:
        t = float(m.get("trades") or 0)
        w = m.get("wins")
        if w is None:
            continue
        wins += float(w)
        trades_total += t
    if trades_total > 0:
        return round((wins / trades_total) * 100.0, 2)

    return 0.0


def infer_symbol_offers(ts_snapshots: dict) -> dict:
    symbol_cards = {
        "BERAUSDT": "ALGOFUND_MASTER::BTDD_D1::bera-pack",
        "IPUSDT": "ALGOFUND_MASTER::BTDD_D1::ip-pack",
        "ORDIUSDT": "ALGOFUND_MASTER::BTDD_D1::ordi-mega",
        "TRUUSDT": "ALGOFUND_MASTER::BTDD_D1::tru-pack",
        "SOMIUSDT": "ALGOFUND_MASTER::BTDD_D1::somi-alpha",
    }

    by_symbol = defaultdict(list)
    offer_to_symbol = {}

    for symbol, set_key in symbol_cards.items():
        item = ts_snapshots.get(set_key) or {}
        offer_ids = item.get("offerIds") if isinstance(item.get("offerIds"), list) else []
        for oid in offer_ids:
            soid = str(oid)
            offer_to_symbol[soid] = symbol
            by_symbol[symbol].append(soid)

    return {"bySymbol": by_symbol, "offerToSymbol": offer_to_symbol}


def pick_diversified(review_snapshots: dict, by_symbol: dict, plan: dict) -> list:
    selected = []
    for symbol, take_count in plan.items():
        offer_ids = list(dict.fromkeys(by_symbol.get(symbol, [])))
        ranked = []
        for oid in offer_ids:
            snap = review_snapshots.get(oid) or {}
            trades = float(snap.get("trades") or 0)
            ret = float(snap.get("ret") or 0)
            pf = float(snap.get("pf") or 0)
            dd = float(snap.get("dd") or 0)
            ranked.append((oid, trades, ret, pf, dd))
        ranked.sort(key=lambda x: (-x[1], -x[2], -x[3], x[4]))
        selected.extend([row[0] for row in ranked[:take_count]])
    return list(dict.fromkeys(selected))


def build_snapshot(
    base: dict,
    set_key: str,
    system_name: str,
    offer_ids: list,
    offer_to_symbol: dict,
    review_snapshots: dict,
    max_open_positions: int,
) -> dict:
    metrics = [review_snapshots.get(oid) or {} for oid in offer_ids]
    ret = avg([m.get("ret") for m in metrics])
    dd = avg([m.get("dd") for m in metrics])
    pf = avg([m.get("pf") for m in metrics])
    win_rate = resolve_win_rate(metrics)
    trades = int(sum(float(m.get("trades") or 0) for m in metrics))
    period_days = float(avg([m.get("periodDays") for m in metrics])) or 90.0
    tpd = trades / max(1.0, period_days)

    symbol_counts = defaultdict(int)
    member_symbols = []
    composition = []
    for oid in offer_ids:
        sym = offer_to_symbol.get(oid, "UNKNOWN")
        symbol_counts[sym] += 1
        member_symbols.append(sym)
        snap = review_snapshots.get(oid) or {}
        composition.append(
            {
                "offerId": oid,
                "symbol": sym,
                "ret": round(float(snap.get("ret") or 0), 3),
                "pf": round(float(snap.get("pf") or 0), 3),
                "dd": round(float(snap.get("dd") or 0), 3),
                "trades": int(float(snap.get("trades") or 0)),
            }
        )

    out = dict(base) if isinstance(base, dict) else {}
    out["setKey"] = set_key
    out["systemName"] = system_name
    out["apiKeyName"] = "BTDD_D1"
    out["offerIds"] = offer_ids
    out["memberSymbols"] = member_symbols
    out["memberSymbolCounts"] = dict(symbol_counts)
    out["composition"] = composition
    out["ret"] = round(ret, 3)
    out["dd"] = round(dd, 3)
    out["pf"] = round(pf, 3)
    out["winRate"] = round(win_rate, 2)
    out["trades"] = trades
    out["periodDays"] = int(round(period_days))
    out["tradesPerDay"] = round(tpd, 3)
    out["finalEquity"] = round(10000.0 * (1.0 + ret / 100.0), 4)
    out["equityPoints"] = aggregate_equity_points(metrics, out["finalEquity"])

    settings = out.get("backtestSettings") if isinstance(out.get("backtestSettings"), dict) else {}
    settings["maxOpenPositions"] = int(max_open_positions)
    settings["minUniqueSymbols"] = len([k for k in symbol_counts.keys() if k != "UNKNOWN"])
    out["backtestSettings"] = settings
    out["updatedAt"] = now_iso()
    return out


def main():
    con = sqlite3.connect(DB_PATH)
    con.row_factory = sqlite3.Row
    cur = con.cursor()

    ts_snapshots = load_flag(cur, TS_KEY)
    review_snapshots = load_flag(cur, REVIEW_KEY)

    if not ts_snapshots or not review_snapshots:
        print(json.dumps({"ok": False, "error": "required_flags_missing"}, ensure_ascii=False, indent=2))
        return

    mapping = infer_symbol_offers(ts_snapshots)
    by_symbol = mapping["bySymbol"]
    offer_to_symbol = mapping["offerToSymbol"]

    hf_plan = {
        "BERAUSDT": 3,
        "ORDIUSDT": 3,
        "TRUUSDT": 2,
        "IPUSDT": 2,
    }
    vp_plan = {
        "BERAUSDT": 3,
        "ORDIUSDT": 2,
        "TRUUSDT": 2,
    }

    hf_offer_ids = pick_diversified(review_snapshots, by_symbol, hf_plan)
    vp_offer_ids = pick_diversified(review_snapshots, by_symbol, vp_plan)

    hf_base = ts_snapshots.get(HF_KEY) or {}
    vp_base = ts_snapshots.get(VP_KEY) or {}

    ts_snapshots[HF_KEY] = build_snapshot(
        base=hf_base,
        set_key=HF_KEY,
        system_name="High Frequency Cloud",
        offer_ids=hf_offer_ids,
        offer_to_symbol=offer_to_symbol,
        review_snapshots=review_snapshots,
        max_open_positions=4,
    )
    ts_snapshots[VP_KEY] = build_snapshot(
        base=vp_base,
        set_key=VP_KEY,
        system_name="Volume Pulse Cloud",
        offer_ids=vp_offer_ids,
        offer_to_symbol=offer_to_symbol,
        review_snapshots=review_snapshots,
        max_open_positions=4,
    )

    cur.execute(
        "UPDATE app_runtime_flags SET value = ? WHERE key = ?",
        (json.dumps(ts_snapshots, ensure_ascii=False), TS_KEY),
    )
    con.commit()

    out = {
        "ok": True,
        "highFreq": {
            "offerCount": len(hf_offer_ids),
            "memberSymbolCounts": ts_snapshots[HF_KEY].get("memberSymbolCounts"),
            "ret": ts_snapshots[HF_KEY].get("ret"),
            "dd": ts_snapshots[HF_KEY].get("dd"),
            "pf": ts_snapshots[HF_KEY].get("pf"),
        },
        "volumePulse": {
            "offerCount": len(vp_offer_ids),
            "memberSymbolCounts": ts_snapshots[VP_KEY].get("memberSymbolCounts"),
            "ret": ts_snapshots[VP_KEY].get("ret"),
            "dd": ts_snapshots[VP_KEY].get("dd"),
            "pf": ts_snapshots[VP_KEY].get("pf"),
        },
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))
    con.close()


if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Extract diversified greedy portfolio from a sweep checkpoint and resolve
strategy names to strategy_ids in backend/database.db.

Greedy rule:
  - sort robust candidates by score (PF * (1 - DD/100) * sqrt(min(trades,300)/300))
  - iterate; accept if (market not yet in portfolio OR allow_dup) AND
    interval/strategy_type bucket below per-bucket cap
  - stop when n_max reached
"""
from __future__ import annotations
import argparse, json, math, os, sqlite3, sys, re

def market_of(name: str) -> str:
    # name pattern includes ..._<MARKET>_<interval>_..., market is BTCUSDT or BTCUSDT_ETHUSDT (synth)
    # We use the underscore-joined uppercase tokens between strategy short and the interval token like 1h/2h/4h/1d
    m = re.search(r'_([A-Z0-9]+USDT(?:_[A-Z0-9]+USDT)?)_(?:1h|2h|4h|1d)_', name)
    return m.group(1) if m else "?"

def interval_of(name: str) -> str:
    m = re.search(r'_(1h|2h|4h|1d)_', name)
    return m.group(1) if m else "?"

def stype_of(name: str) -> str:
    if "_DD_" in name: return "DD"
    if "_SZ_" in name: return "SZ"  # stat_arb_zscore
    if "_ZZ_" in name: return "ZZ"  # zz_breakout
    return "?"

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--checkpoint", required=True)
    ap.add_argument("--db", default="backend/database.db")
    ap.add_argument("--n", type=int, default=60)
    ap.add_argument("--min-pf", type=float, default=1.3)
    ap.add_argument("--max-dd", type=float, default=8.0)
    ap.add_argument("--min-trades", type=int, default=30)
    ap.add_argument("--max-per-market", type=int, default=2)
    ap.add_argument("--max-per-bucket", type=int, default=8)  # bucket = interval+stype
    ap.add_argument("--out-ids", default="")
    ap.add_argument("--out-names", default="")
    args = ap.parse_args()

    d = json.load(open(args.checkpoint))
    ev = d.get("evaluated") or []
    print(f"checkpoint evaluated rows: {len(ev)}", file=sys.stderr)

    # robust filter
    robust = []
    for r in ev:
        pf = r.get("profitFactor") or r.get("profit_factor") or 0
        dd = r.get("maxDrawdownPercent") if r.get("maxDrawdownPercent") is not None else (r.get("max_drawdown_percent") or 999)
        tr = r.get("tradesCount") or r.get("trades") or r.get("trades_count") or 0
        ret = r.get("totalReturnPercent") if r.get("totalReturnPercent") is not None else (r.get("total_return_percent") or 0)
        name = r.get("strategyName") or r.get("strategy_name") or r.get("name") or ""
        sid = r.get("strategyId") or r.get("strategy_id")
        if not name: continue
        if pf < args.min_pf: continue
        if dd > args.max_dd: continue
        if tr < args.min_trades: continue
        if ret <= 0: continue
        score = pf * (1 - dd/100) * math.sqrt(min(tr, 300)/300)
        robust.append({
            "name": name, "id": sid, "pf": pf, "dd": dd, "trades": tr, "ret": ret, "score": score,
            "market": market_of(name), "interval": interval_of(name), "stype": stype_of(name),
        })
    robust.sort(key=lambda x: -x["score"])
    print(f"robust candidates after filter: {len(robust)}", file=sys.stderr)

    # greedy
    portfolio = []
    market_count = {}
    bucket_count = {}
    for c in robust:
        if len(portfolio) >= args.n: break
        if market_count.get(c["market"], 0) >= args.max_per_market: continue
        bk = f"{c['interval']}_{c['stype']}"
        if bucket_count.get(bk, 0) >= args.max_per_bucket: continue
        portfolio.append(c)
        market_count[c["market"]] = market_count.get(c["market"], 0) + 1
        bucket_count[bk] = bucket_count.get(bk, 0) + 1

    print(f"selected: {len(portfolio)} strategies / {len(market_count)} markets / {len(bucket_count)} buckets", file=sys.stderr)

    # resolve names -> ids (use checkpoint id if present, else look up by name)
    conn = sqlite3.connect(args.db)
    cur = conn.cursor()
    ids = []
    missing = []
    for c in portfolio:
        if c.get("id"):
            ids.append(c["id"]); continue
        cur.execute("SELECT id FROM strategies WHERE name=? LIMIT 1", (c["name"],))
        r = cur.fetchone()
        if r:
            c["id"] = r[0]; ids.append(r[0])
        else:
            missing.append(c["name"])
    print(f"resolved ids: {len(ids)}, missing: {len(missing)}", file=sys.stderr)
    if missing[:3]:
        print(f"sample missing: {missing[:3]}", file=sys.stderr)

    # bucket distribution
    print("\nBucket distribution:", file=sys.stderr)
    for bk in sorted(bucket_count): print(f"  {bk}: {bucket_count[bk]}", file=sys.stderr)
    print("\nMarket distribution (top 20):", file=sys.stderr)
    for m, n in sorted(market_count.items(), key=lambda x: -x[1])[:20]:
        print(f"  {m}: {n}", file=sys.stderr)

    out = {
        "n_selected": len(portfolio),
        "n_markets": len(market_count),
        "naive_avg_return": round(sum(c["ret"] for c in portfolio) / max(1, len(portfolio)), 4),
        "naive_avg_dd": round(sum(c["dd"] for c in portfolio) / max(1, len(portfolio)), 4),
        "naive_total_trades": sum(c["trades"] for c in portfolio),
        "strategies": [
            {"id": c.get("id"), "name": c["name"], "pf": c["pf"], "dd": c["dd"],
             "trades": c["trades"], "ret": c["ret"], "score": round(c["score"],4),
             "market": c["market"], "interval": c["interval"], "stype": c["stype"]}
            for c in portfolio
        ],
        "filters": {"min_pf": args.min_pf, "max_dd": args.max_dd, "min_trades": args.min_trades,
                    "max_per_market": args.max_per_market, "max_per_bucket": args.max_per_bucket},
    }
    print(json.dumps(out, indent=2))

    if args.out_ids and ids:
        open(args.out_ids,"w").write(",".join(str(x) for x in ids))
        print(f"\nIDs written to {args.out_ids}", file=sys.stderr)
    if args.out_names:
        open(args.out_names,"w").write("\n".join(c["name"] for c in portfolio))

if __name__ == "__main__":
    main()

#!/usr/bin/env python3
"""
Portfolio equity-curve backtest.

Re-aggregates per-strategy backtest trades from `backtest_runs.trades_json`
into a TIME-ALIGNED portfolio equity curve and computes REAL portfolio metrics:
  - total_return_percent       (compound)
  - max_drawdown_percent       (on portfolio equity)
  - sharpe_ratio (annualized, daily resampled)
  - sortino_ratio
  - calmar_ratio
  - cagr_percent
  - per-strategy contribution
  - pairwise pnl-return correlation matrix (daily)

Input:
  --strategy-ids "id1,id2,..."         OR
  --strategy-names-file file.txt       (one name per line; resolved via DB)
Optional:
  --weights "w1,w2,..."   default = equal
  --initial-balance       default = 10000
  --mode                  compound (default) | fixed_notional
  --rebalance             never (default) | monthly | yearly
  --output                json output path (default stdout summary only)
  --db                    backend/database.db path (default: ./backend/database.db)
  --date-from / --date-to ISO timestamps to clip the portfolio period

Picks the LATEST backtest_run per strategy_id (rows with strategy_ids = "[id]").
"""
from __future__ import annotations
import argparse, json, math, os, sqlite3, sys
from collections import defaultdict
from datetime import datetime, timezone

def parse_iso(s: str) -> int:
    if not s: return 0
    if s.endswith("Z"): s = s.replace("Z","+00:00")
    return int(datetime.fromisoformat(s).replace(tzinfo=timezone.utc if "+" not in s else None).timestamp() * 1000)

def fmt_ts(ms: int) -> str:
    return datetime.utcfromtimestamp(ms/1000).strftime("%Y-%m-%d")

def load_latest_runs(conn, strategy_ids):
    """Return {sid: {trades, run_id, name, period_from_ms, period_to_ms}} for the latest single-strategy run."""
    out = {}
    cur = conn.cursor()
    for sid in strategy_ids:
        # Must be a single-strategy run: strategy_ids JSON exactly "[sid]"
        cur.execute(
            "SELECT id, strategy_names, trades_json, equity_curve_json, total_return_percent, "
            "max_drawdown_percent, profit_factor, trades_count, created_at "
            "FROM backtest_runs WHERE strategy_ids = ? ORDER BY id DESC LIMIT 1",
            (json.dumps([int(sid)]),),
        )
        row = cur.fetchone()
        if not row:
            print(f"[WARN] no single-strategy backtest_run for strategy_id={sid}", file=sys.stderr)
            continue
        try:
            trades = json.loads(row[2] or "[]")
        except Exception as e:
            print(f"[WARN] parse trades_json for sid={sid}: {e}", file=sys.stderr)
            continue
        try:
            equity = json.loads(row[3] or "[]")
        except Exception:
            equity = []
        if not trades:
            print(f"[INFO] sid={sid} run_id={row[0]} has 0 trades — skipping", file=sys.stderr)
            continue
        period_from = min(t.get("entryTime", 0) for t in trades) if trades else 0
        period_to = max(t.get("exitTime", 0) for t in trades) if trades else 0
        out[int(sid)] = {
            "run_id": row[0],
            "strategy_name": json.loads(row[1] or "[]")[0] if row[1] else f"sid_{sid}",
            "trades": trades,
            "equity_curve": equity,
            "iso_total_return": row[4],
            "iso_max_dd": row[5],
            "iso_pf": row[6],
            "iso_trades": row[7],
            "period_from_ms": period_from,
            "period_to_ms": period_to,
            "created_at": row[8],
        }
    return out

def daily_returns(equity_points):
    """equity_points: sorted list of (ts_ms, equity). Resample to daily, return list of fractional returns."""
    if len(equity_points) < 2: return []
    by_day = {}
    for ts, eq in equity_points:
        day = ts // 86400000
        by_day[day] = eq  # last value wins per day
    days = sorted(by_day.keys())
    rets = []
    prev = by_day[days[0]]
    for d in days[1:]:
        cur = by_day[d]
        if prev > 0:
            rets.append(cur/prev - 1)
        prev = cur
    return rets

def compute_metrics(curve, period_days):
    """curve: [(ts_ms, equity)]. Returns dict of metrics."""
    if len(curve) < 2:
        return {"total_return_percent": 0, "max_drawdown_percent": 0,
                "sharpe": 0, "sortino": 0, "calmar": 0, "cagr_percent": 0,
                "days": 0}
    equities = [e for _, e in curve]
    initial = equities[0]; final = equities[-1]
    total_ret = (final/initial - 1) * 100 if initial > 0 else 0
    peak = equities[0]; max_dd = 0
    for e in equities:
        if e > peak: peak = e
        dd = (peak - e) / peak * 100 if peak > 0 else 0
        if dd > max_dd: max_dd = dd
    rets = daily_returns(curve)
    if rets:
        mean = sum(rets) / len(rets)
        var = sum((r-mean)**2 for r in rets) / max(1, len(rets)-1)
        std = math.sqrt(var)
        sharpe = (mean / std) * math.sqrt(365) if std > 0 else 0
        downside = [r for r in rets if r < 0]
        if downside:
            dvar = sum(r*r for r in downside) / len(downside)
            dstd = math.sqrt(dvar)
            sortino = (mean / dstd) * math.sqrt(365) if dstd > 0 else 0
        else:
            sortino = 0
    else:
        sharpe = sortino = 0
    years = period_days / 365.25 if period_days > 0 else 0
    cagr = ((final/initial) ** (1/years) - 1) * 100 if (years > 0 and initial > 0 and final > 0) else 0
    calmar = (cagr / max_dd) if max_dd > 0 else 0
    return {
        "total_return_percent": round(total_ret, 4),
        "max_drawdown_percent": round(max_dd, 4),
        "sharpe": round(sharpe, 4),
        "sortino": round(sortino, 4),
        "calmar": round(calmar, 4),
        "cagr_percent": round(cagr, 4),
        "days": period_days,
        "final_equity": round(final, 2),
        "initial_equity": round(initial, 2),
    }

def build_portfolio_curve(runs, weights, initial_balance, mode, t0_ms, t1_ms):
    """
    Returns (curve, per_strategy_curves).
    mode:
      compound        — each strategy compounds within its own slice
      fixed_notional  — per-trade pnl scaled to its slice (no compounding)
    """
    sids = sorted(runs.keys())
    # Normalize weights
    if not weights:
        w = [1.0/len(sids)] * len(sids)
    else:
        s = sum(weights)
        w = [x/s for x in weights]
    slice_caps = {sid: initial_balance * w[i] for i, sid in enumerate(sids)}

    # Collect every event timestamp (entry & exit) clipped to window, plus daily ticks.
    all_times = set([t0_ms, t1_ms])
    for sid, info in runs.items():
        for t in info["trades"]:
            for k in ("entryTime", "exitTime"):
                ts = t.get(k)
                if ts and t0_ms <= ts <= t1_ms:
                    all_times.add(ts)
    # Add daily granularity ticks for charting & daily-return resampling.
    day_ms = 86400000
    cur = (t0_ms // day_ms) * day_ms
    while cur <= t1_ms:
        all_times.add(cur)
        cur += day_ms
    timeline = sorted(all_times)

    per_strat_curves = {sid: [] for sid in sids}
    portfolio_curve = []

    # Pre-sort each strategy trades by exitTime
    trades_by_sid = {sid: sorted(info["trades"], key=lambda x: x.get("exitTime", 0)) for sid, info in runs.items()}
    idx = {sid: 0 for sid in sids}
    realized = {sid: 0.0 for sid in sids}        # cumulative net pnl in dollars within the slice
    equity = {sid: slice_caps[sid] for sid in sids}

    for ts in timeline:
        # Apply trades that closed at or before ts (idempotent advance)
        for sid in sids:
            ts_trades = trades_by_sid[sid]
            cap = slice_caps[sid]
            while idx[sid] < len(ts_trades) and ts_trades[idx[sid]].get("exitTime", 0) <= ts:
                tr = ts_trades[idx[sid]]
                if tr.get("entryTime", 0) < t0_ms:
                    idx[sid] += 1; continue
                pnl_pct = tr.get("pnlPercent")
                if pnl_pct is None:
                    notional = tr.get("notional", 0) or 0
                    net = tr.get("netPnl", 0) or 0
                    pnl_pct = (net / notional * 100) if notional else 0
                fr = pnl_pct / 100.0  # fractional return on notional (slice cap)
                if mode == "compound":
                    equity[sid] = equity[sid] * (1 + fr)
                else:  # fixed_notional
                    realized[sid] += fr * cap
                    equity[sid] = cap + realized[sid]
                idx[sid] += 1
            per_strat_curves[sid].append((ts, equity[sid]))
        portfolio_eq = sum(equity[sid] for sid in sids)
        portfolio_curve.append((ts, portfolio_eq))

    return portfolio_curve, per_strat_curves, slice_caps

def correlation(a, b):
    n = min(len(a), len(b))
    if n < 3: return 0
    a = a[-n:]; b = b[-n:]
    ma = sum(a)/n; mb = sum(b)/n
    num = sum((a[i]-ma)*(b[i]-mb) for i in range(n))
    da = math.sqrt(sum((a[i]-ma)**2 for i in range(n)))
    db = math.sqrt(sum((b[i]-mb)**2 for i in range(n)))
    if da == 0 or db == 0: return 0
    return num / (da * db)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=os.path.join(os.path.dirname(__file__), "..", "backend", "database.db"))
    ap.add_argument("--strategy-ids", default="")
    ap.add_argument("--strategy-names-file", default="")
    ap.add_argument("--weights", default="")
    ap.add_argument("--initial-balance", type=float, default=10000.0)
    ap.add_argument("--mode", default="compound", choices=["compound", "fixed_notional"])
    ap.add_argument("--date-from", default="")
    ap.add_argument("--date-to", default="")
    ap.add_argument("--output", default="")
    ap.add_argument("--equity-output", default="", help="Write portfolio_curve as CSV (ts,equity)")
    args = ap.parse_args()

    db_path = os.path.abspath(args.db)
    if not os.path.isfile(db_path):
        print(f"DB not found: {db_path}", file=sys.stderr); sys.exit(2)
    conn = sqlite3.connect(db_path)

    # Resolve strategy ids
    sids = []
    if args.strategy_ids:
        sids = [int(x) for x in args.strategy_ids.split(",") if x.strip()]
    elif args.strategy_names_file:
        names = [l.strip() for l in open(args.strategy_names_file) if l.strip() and not l.startswith("#")]
        cur = conn.cursor()
        for nm in names:
            cur.execute("SELECT id FROM strategies WHERE name = ? LIMIT 1", (nm,))
            r = cur.fetchone()
            if r: sids.append(r[0])
            else: print(f"[WARN] strategy not found by name: {nm}", file=sys.stderr)
    else:
        print("Need --strategy-ids or --strategy-names-file", file=sys.stderr); sys.exit(2)

    if not sids:
        print("No strategies resolved.", file=sys.stderr); sys.exit(2)

    runs = load_latest_runs(conn, sids)
    if not runs:
        print("No backtest runs found for any strategy.", file=sys.stderr); sys.exit(2)

    # Determine common time window
    t0 = max((r["period_from_ms"] for r in runs.values() if r["period_from_ms"]), default=0)
    t1 = min((r["period_to_ms"]   for r in runs.values() if r["period_to_ms"]),   default=0)
    if args.date_from:
        t0 = max(t0, parse_iso(args.date_from))
    if args.date_to:
        t1 = min(t1, parse_iso(args.date_to))
    if t1 <= t0:
        print(f"Empty common window: t0={fmt_ts(t0)} t1={fmt_ts(t1)}. Strategies don't overlap.", file=sys.stderr)
        sys.exit(2)

    weights = [float(x) for x in args.weights.split(",")] if args.weights else []
    if weights and len(weights) != len(runs):
        print(f"weights count ({len(weights)}) != strategies count ({len(runs)})", file=sys.stderr)
        sys.exit(2)

    portfolio_curve, per_strat_curves, slice_caps = build_portfolio_curve(
        runs, weights, args.initial_balance, args.mode, t0, t1
    )
    period_days = max(1, (t1 - t0) // 86400000)
    pmetrics = compute_metrics(portfolio_curve, period_days)

    # Per-strategy contribution metrics on the SAME window/slice
    per_strat_summary = []
    daily_per_strat = {}
    for sid, curve in per_strat_curves.items():
        m = compute_metrics(curve, period_days)
        info = runs[sid]
        m.update({
            "strategy_id": sid,
            "strategy_name": info["strategy_name"],
            "slice_capital": round(slice_caps[sid], 2),
            "trades_in_period": sum(1 for t in info["trades"] if t.get("exitTime",0) >= t0 and t.get("exitTime",0) <= t1),
            "iso_total_return_full": info["iso_total_return"],
            "iso_max_dd_full": info["iso_max_dd"],
            "iso_pf_full": info["iso_pf"],
            "iso_trades_full": info["iso_trades"],
            "period_from": fmt_ts(info["period_from_ms"]),
            "period_to": fmt_ts(info["period_to_ms"]),
        })
        per_strat_summary.append(m)
        daily_per_strat[sid] = daily_returns(curve)

    # Correlation matrix on daily returns within window
    sids_sorted = sorted(daily_per_strat.keys())
    corr = {}
    for i, a in enumerate(sids_sorted):
        for b in sids_sorted[i+1:]:
            c = correlation(daily_per_strat[a], daily_per_strat[b])
            corr[f"{a}|{b}"] = round(c, 4)
    avg_corr = (sum(corr.values()) / len(corr)) if corr else 0

    summary = {
        "portfolio": pmetrics,
        "window": {"from": fmt_ts(t0), "to": fmt_ts(t1), "days": period_days},
        "n_strategies": len(runs),
        "mode": args.mode,
        "initial_balance": args.initial_balance,
        "avg_pairwise_correlation": round(avg_corr, 4),
        "per_strategy": sorted(per_strat_summary, key=lambda x: -x["total_return_percent"]),
        "correlation_matrix_pairs": corr,
        "naive_avg_of_isolated_returns_percent": round(
            sum((r["iso_total_return"] or 0) for r in runs.values()) / len(runs), 4
        ),
    }

    print("=" * 72)
    print(f"PORTFOLIO BACKTEST  ({len(runs)} strategies, mode={args.mode})")
    print(f"window: {summary['window']['from']} → {summary['window']['to']}  ({period_days} days)")
    print(f"initial_balance: ${args.initial_balance:.0f}  →  final: ${pmetrics['final_equity']:.2f}")
    print("-" * 72)
    print(f"  total return:  {pmetrics['total_return_percent']:+.2f}%")
    print(f"  CAGR:          {pmetrics['cagr_percent']:+.2f}%")
    print(f"  max drawdown:  {pmetrics['max_drawdown_percent']:.2f}%")
    print(f"  sharpe (ann):  {pmetrics['sharpe']:.3f}")
    print(f"  sortino:       {pmetrics['sortino']:.3f}")
    print(f"  calmar:        {pmetrics['calmar']:.3f}")
    print(f"  avg pair corr: {summary['avg_pairwise_correlation']:.3f}")
    print("-" * 72)
    print(f"  naive arithmetic mean of isolated full-period returns: "
          f"{summary['naive_avg_of_isolated_returns_percent']:+.2f}%   "
          f"(this is what the older 'sweep avg' showed; NOT a real portfolio metric)")
    print("=" * 72)
    print(f"Top 5 contributors (by window return):")
    for s in summary["per_strategy"][:5]:
        print(f"  {s['strategy_id']:7d}  {s['strategy_name'][:48]:48s}  "
              f"ret={s['total_return_percent']:+7.2f}%  dd={s['max_drawdown_percent']:5.2f}%  "
              f"trades={s['trades_in_period']:4d}")
    if len(summary["per_strategy"]) > 5:
        print(f"Bottom 5 contributors:")
        for s in summary["per_strategy"][-5:]:
            print(f"  {s['strategy_id']:7d}  {s['strategy_name'][:48]:48s}  "
                  f"ret={s['total_return_percent']:+7.2f}%  dd={s['max_drawdown_percent']:5.2f}%  "
                  f"trades={s['trades_in_period']:4d}")

    if args.output:
        with open(args.output, "w") as fh:
            json.dump(summary, fh, indent=2)
        print(f"\nFull JSON written to: {args.output}")
    if args.equity_output:
        with open(args.equity_output, "w") as fh:
            fh.write("ts_ms,iso_date,equity\n")
            for ts, eq in portfolio_curve:
                fh.write(f"{ts},{datetime.utcfromtimestamp(ts/1000).isoformat()},{eq:.4f}\n")
        print(f"Equity CSV: {args.equity_output}")

if __name__ == "__main__":
    main()

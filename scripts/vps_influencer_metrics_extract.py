#!/usr/bin/env python3
import json
import math
import sqlite3
from statistics import pstdev, mean

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
KEY = 'offer.store.ts_backtest_snapshots'
TARGETS = [
    'ALGOFUND_MASTER::BTDD_D1::safe-yield',
    'ALGOFUND_MASTER::BTDD_D1::mega-portfolio',
    'ALGOFUND_MASTER::BTDD_D1::high-freq',
]

DEPOSIT = 100000.0
UTIL = 0.25
COMMISSION_RT = 0.0012


def sharpe_from_equity(points):
    if not isinstance(points, list) or len(points) < 3:
        return None
    rets = []
    for i in range(1, len(points)):
        prev = float(points[i - 1] or 0)
        cur = float(points[i] or 0)
        if prev <= 0:
            continue
        rets.append((cur - prev) / prev)
    if len(rets) < 2:
        return None
    m = mean(rets)
    sd = pstdev(rets)
    if sd <= 1e-12:
        return None
    # Equity points in snapshot are near-daily, annualize by sqrt(365)
    return (m / sd) * math.sqrt(365)


def dd_periods(points):
    if not isinstance(points, list) or len(points) < 2:
        return {'maxDrawdownBars': None, 'avgDrawdownBars': None, 'periodsCount': 0}
    peak = float(points[0] or 0)
    cur_bars = 0
    periods = []
    for x in points[1:]:
        v = float(x or 0)
        if v >= peak:
            if cur_bars > 0:
                periods.append(cur_bars)
                cur_bars = 0
            peak = v
        else:
            cur_bars += 1
    if cur_bars > 0:
        periods.append(cur_bars)
    if not periods:
        return {'maxDrawdownBars': 0, 'avgDrawdownBars': 0, 'periodsCount': 0}
    return {
        'maxDrawdownBars': max(periods),
        'avgDrawdownBars': round(sum(periods) / len(periods), 2),
        'periodsCount': len(periods),
    }


con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()
row = cur.execute('SELECT value FROM app_runtime_flags WHERE key = ?', (KEY,)).fetchone()
if not row:
    raise SystemExit('snapshot key not found')

snapshots = json.loads(row['value'] or '{}')

out = []
for key in TARGETS:
    s = snapshots.get(key) or {}
    trades = float(s.get('trades') or 0)
    period_days = float(s.get('periodDays') or 0)
    ret = float(s.get('ret') or 0)
    dd = float(s.get('dd') or 0)
    pf = float(s.get('pf') or 0)
    wr = float(s.get('winRate') or 0)
    final_equity = float(s.get('finalEquity') or 0)
    points = s.get('equityPoints') if isinstance(s.get('equityPoints'), list) else []
    initial = 10000.0
    pnl = final_equity - initial

    annual_trades = (trades / period_days) * 365.0 if period_days > 0 else 0.0
    period_profit_on_100k = DEPOSIT * (ret / 100.0)
    avg_profit_per_trade_usd = (period_profit_on_100k / trades) if trades > 0 else 0.0
    avg_profit_per_trade_pct = (avg_profit_per_trade_usd / DEPOSIT) * 100.0 if DEPOSIT > 0 else 0.0
    commission_total = DEPOSIT * UTIL * COMMISSION_RT * trades
    calmar = (ret / dd) if dd > 1e-12 else None

    out.append({
        'setKey': key,
        'systemName': s.get('systemName'),
        'ret90dPercent': ret,
        'maxDD90dPercent': dd,
        'profitFactor': pf,
        'winRatePercent': wr,
        'trades90d': int(trades),
        'tradesPerDay': s.get('tradesPerDay'),
        'annualizedTrades': round(annual_trades, 2),
        'avgProfitPerTradeUsd_100k': round(avg_profit_per_trade_usd, 4),
        'avgProfitPerTradePct_100k': round(avg_profit_per_trade_pct, 6),
        'commissionTotalUsd_100k': round(commission_total, 2),
        'calmar': round(calmar, 4) if calmar is not None else None,
        'sharpeFromEquity': round(sharpe_from_equity(points), 4) if sharpe_from_equity(points) is not None else None,
        'drawdownPeriods': dd_periods(points),
        'finalEquity10k': final_equity,
        'netPnl10k': round(pnl, 4),
    })

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

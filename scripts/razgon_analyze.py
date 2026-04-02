import json
from datetime import datetime
from collections import defaultdict

trades = json.load(open('scripts/razgon_spot_trades.json'))
trades.sort(key=lambda t: int(t['time']))

t_first = datetime.utcfromtimestamp(int(trades[0]['time'])/1000)
t_last = datetime.utcfromtimestamp(int(trades[-1]['time'])/1000)
duration_min = (int(trades[-1]['time']) - int(trades[0]['time'])) / 60000

buys = [t for t in trades if t['isBuyer']]
sells = [t for t in trades if not t['isBuyer']]
total_buy_usdt = sum(float(t['quoteQty']) for t in buys)
total_sell_usdt = sum(float(t['quoteQty']) for t in sells)
total_buy_qty = sum(float(t['qty']) for t in buys)
total_sell_qty = sum(float(t['qty']) for t in sells)
net_usdt = total_sell_usdt - total_buy_usdt
net_qty = total_buy_qty - total_sell_qty
commissions = sum(float(t['commission']) for t in trades)
comm_assets = set(t['commissionAsset'] for t in trades)

print("=== SPOT PALMAI ANALYSIS ===")
print(f"Period: {t_first} -> {t_last} ({duration_min:.1f} min)")
print(f"Buy: {total_buy_qty:.2f} PALMAI for {total_buy_usdt:.2f} USDT ({len(buys)} trades)")
print(f"Sell: {total_sell_qty:.2f} PALMAI for {total_sell_usdt:.2f} USDT ({len(sells)} trades)")
print(f"Net USDT P&L (sells-buys): {net_usdt:.4f} USDT")
print(f"Net PALMAI remaining: {net_qty:.2f}")
print(f"Commission assets: {comm_assets}")
print(f"Total commission: {commissions:.6f}")

prices = [(int(t['time']), float(t['price']), t['isBuyer']) for t in trades]
print(f"Price start: {prices[0][1]}, end: {prices[-1][1]}")
print(f"Price min: {min(p[1] for p in prices)}, max: {max(p[1] for p in prices)}")

intervals = [(prices[i+1][0] - prices[i][0]) for i in range(len(prices)-1)]
avg_interval = sum(intervals)/len(intervals) if intervals else 0
print(f"Avg interval between trades: {avg_interval:.0f}ms ({avg_interval/1000:.1f}s)")

qtys = [float(t['quoteQty']) for t in trades]
print(f"Avg trade size: {sum(qtys)/len(qtys):.2f} USDT")
print(f"Min/Max trade size: {min(qtys):.2f} / {max(qtys):.2f} USDT")

# Buy/sell pattern - are buys and sells alternating?
pattern = ''.join('B' if t['isBuyer'] else 'S' for t in trades[:50])
print(f"\nFirst 50 trades pattern: {pattern}")

# Futures
print("\n=== FUTURES ANALYSIS ===")
futures = json.load(open('scripts/razgon_futures_orders.json'))
orders = futures.get('data', [])
print(f"Total futures orders: {len(orders)}")

by_sym = defaultdict(list)
for o in orders:
    by_sym[o['symbol']].append(o)

sides_map = {1: 'open_long', 2: 'close_short', 3: 'open_short', 4: 'close_long'}
for sym, ords in by_sym.items():
    filled = [o for o in ords if o['state'] == 3]
    cancelled = [o for o in ords if o['state'] == 4]
    profit_total = sum(o.get('profit', 0) for o in filled)
    times = [o['createTime'] for o in ords]
    t_min = datetime.utcfromtimestamp(min(times)/1000)
    t_max = datetime.utcfromtimestamp(max(times)/1000)
    dur = (max(times) - min(times)) / 60000
    side_counts = defaultdict(int)
    for o in filled:
        side_counts[sides_map.get(o['side'], o['side'])] += 1
    total_margin = sum(o.get('usedMargin', 0) for o in filled)
    print(f"\n{sym}: {len(ords)} orders ({len(filled)} filled, {len(cancelled)} cancelled)")
    print(f"  Leverage: {set(o['leverage'] for o in ords)}")
    print(f"  Period: {t_min} -> {t_max} ({dur:.1f} min)")
    print(f"  Total profit: {profit_total:.4f} USDT")
    print(f"  Sides: {dict(side_counts)}")
    print(f"  Total margin used: {total_margin:.4f} USDT")
    for o in filled:
        t = datetime.utcfromtimestamp(o['createTime']/1000)
        s = sides_map.get(o['side'], o['side'])
        print(f"    {t} {s} vol={o['dealVol']} price={o['dealAvgPrice']} profit={o['profit']}")

# USDT balance in futures
print("\n=== FUTURES USDT BALANCE ===")
assets = json.load(open('scripts/razgon_futures_assets.json'))
for a in assets.get('data', []):
    if a.get('cashBalance', 0) != 0 or a.get('currency') == 'USDT':
        print(f"  {a['currency']}: balance={a.get('cashBalance',0)}, equity={a.get('equity',0)}")

# Spot non-zero balances
print("\n=== SPOT ACCOUNT ===")
acct = json.load(open('scripts/razgon_spot_account.json'))
for b in acct.get('balances', []):
    if float(b.get('free', 0)) > 0 or float(b.get('locked', 0)) > 0:
        print(f"  {b['asset']}: free={b['free']}, locked={b['locked']}")

# Cross-analysis: timeline
print("\n=== TIMELINE ===")
spot_start = int(trades[0]['time'])
spot_end = int(trades[-1]['time'])
fut_times = [o['createTime'] for o in orders]
if fut_times:
    fut_start = min(fut_times)
    fut_end = max(fut_times)
    print(f"Spot: {datetime.utcfromtimestamp(spot_start/1000)} -> {datetime.utcfromtimestamp(spot_end/1000)}")
    print(f"Futures: {datetime.utcfromtimestamp(fut_start/1000)} -> {datetime.utcfromtimestamp(fut_end/1000)}")
    print(f"Gap spot->futures: {(fut_start - spot_end)/60000:.1f} min")

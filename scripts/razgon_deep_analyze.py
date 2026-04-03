import json
from datetime import datetime, timezone
from collections import defaultdict

# Fix UTF-16 if needed
for name in ['razgon_deep_fut_orders', 'razgon_deep_positions', 'razgon_deep_funding', 'razgon_deep_assets']:
    fp = f'scripts/{name}.json'
    try:
        with open(fp, 'r', encoding='utf-8') as f:
            json.loads(f.read())
    except:
        try:
            with open(fp, 'r', encoding='utf-16') as f:
                data = json.loads(f.read())
            with open(fp, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            print(f'{name}: fixed encoding')
        except Exception as e:
            print(f'{name}: {e}')

# Load data
orders = json.load(open('scripts/razgon_deep_fut_orders.json'))
positions = json.load(open('scripts/razgon_deep_positions.json'))
funding = json.load(open('scripts/razgon_deep_funding.json'))
assets = json.load(open('scripts/razgon_deep_assets.json'))
spot_trades = json.load(open('scripts/razgon_spot_trades.json'))

def ts(ms):
    return datetime.fromtimestamp(ms/1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S')

print("=" * 70)
print("FULL RAZGON ANALYSIS — client1")
print("=" * 70)

# ── POSITION HISTORY (closed positions) ──
print("\n\n### FUTURES CLOSED POSITIONS ###")
pos_data = positions if isinstance(positions, list) else []
print(f"Total closed positions: {len(pos_data)}")

# Sort by open time
pos_data.sort(key=lambda p: p.get('openTime', p.get('createTime', 0)))

by_sym = defaultdict(list)
for p in pos_data:
    by_sym[p.get('symbol', '?')].append(p)

total_realized_pnl = 0
total_fee = 0
for sym in sorted(by_sym.keys()):
    pp = by_sym[sym]
    pnl = sum(p.get('realised', 0) for p in pp)
    fee = sum(p.get('positionFee', 0) + p.get('openAvgPrice', 0) * 0 for p in pp)  
    total_realized_pnl += pnl
    print(f"\n  {sym}: {len(pp)} positions, realized PnL = {pnl:.4f} USDT")
    for p in pp:
        ot = ts(p.get('openTime', p.get('createTime', 0)))
        ct = ts(p.get('closeTime', p.get('updateTime', 0)))
        side = 'LONG' if p.get('positionType', 0) == 1 else 'SHORT'
        lev = p.get('leverage', '?')
        vol = p.get('closeTotalPos', p.get('holdVol', '?'))
        oprice = p.get('openAvgPrice', '?')
        cprice = p.get('closeAvgPrice', '?')
        rpnl = p.get('realised', 0)
        print(f"    {ot} -> {ct} | {side} {lev}x | vol={vol} | open={oprice} close={cprice} | PnL={rpnl:.4f}")

print(f"\n  ** TOTAL realized PnL across all positions: {total_realized_pnl:.4f} USDT **")

# ── FUTURES ORDERS ──
print("\n\n### FUTURES ORDER HISTORY ###")
ord_data = orders if isinstance(orders, list) else []
print(f"Total orders: {len(ord_data)}")

# Sort by time, find earliest
ord_data.sort(key=lambda o: o.get('createTime', 0))
if ord_data:
    print(f"Earliest order: {ts(ord_data[0]['createTime'])}")
    print(f"Latest order: {ts(ord_data[-1]['createTime'])}")

# Group by symbol and compute stats
by_sym2 = defaultdict(list)
for o in ord_data:
    by_sym2[o['symbol']].append(o)

sides_map = {1: 'open_long', 2: 'close_short', 3: 'open_short', 4: 'close_long'}
for sym in sorted(by_sym2.keys()):
    oo = by_sym2[sym]
    filled = [o for o in oo if o['state'] == 3]
    cancelled = [o for o in oo if o['state'] == 4]
    pnl = sum(o.get('profit', 0) for o in filled)
    fees = sum(o.get('totalFee', 0) for o in filled)
    margin = sum(o.get('usedMargin', 0) for o in filled)
    print(f"\n  {sym}: {len(oo)} orders ({len(filled)} filled, {len(cancelled)} cancel)")
    print(f"    PnL={pnl:.4f}, fees={fees:.4f}, margin={margin:.4f}")
    print(f"    Period: {ts(oo[0]['createTime'])} -> {ts(oo[-1]['createTime'])}")
    for o in filled:
        s = sides_map.get(o['side'], '?')
        print(f"      {ts(o['createTime'])} {s} vol={o['dealVol']} @{o['dealAvgPrice']} profit={o['profit']:.4f} fee={o.get('totalFee',0):.4f}")

# ── SPOT TRADES TIMELINE ──
print("\n\n### SPOT TRADES TIMELINE ###")
spot_trades.sort(key=lambda t: int(t['time']))
print(f"Total: {len(spot_trades)} trades")
print(f"First: {ts(int(spot_trades[0]['time']))}")
print(f"Last: {ts(int(spot_trades[-1]['time']))}")

buys = [t for t in spot_trades if t['isBuyer']]
sells = [t for t in spot_trades if not t['isBuyer']]
buy_usdt = sum(float(t['quoteQty']) for t in buys)
sell_usdt = sum(float(t['quoteQty']) for t in sells)
net = sell_usdt - buy_usdt
comm = sum(float(t['commission']) for t in spot_trades)
print(f"Buy: {buy_usdt:.2f} USDT ({len(buys)} trades)")
print(f"Sell: {sell_usdt:.2f} USDT ({len(sells)} trades)")
print(f"Net PnL: {net:.4f} USDT")
print(f"Commission: {comm:.4f} USDT")

# ── FUNDING RECORDS ──
print("\n\n### FUTURES FUNDING ###")
fund_data = funding.get('data', funding) if isinstance(funding, dict) else funding
if isinstance(fund_data, dict):
    fund_data = fund_data.get('resultList', fund_data.get('data', []))
if isinstance(fund_data, list):
    print(f"Funding records: {len(fund_data)}")
    for f in fund_data[:20]:
        print(f"  {f}")
else:
    print(f"Funding: {fund_data}")

# ── FUTURES USDT ASSET ──
print("\n\n### FUTURES BALANCE ###")
asset_data = assets.get('data', []) if isinstance(assets, dict) else assets
for a in asset_data:
    if a.get('cashBalance', 0) != 0 or a.get('currency') == 'USDT':
        print(f"  {a['currency']}: cash={a.get('cashBalance',0)}, equity={a.get('equity',0)}, unrealized={a.get('unrealized',0)}")

# ── GRAND SUMMARY ──
print("\n\n" + "=" * 70)
print("GRAND SUMMARY")
print("=" * 70)

# Timeline
all_times = []
for t in spot_trades:
    all_times.append(('SPOT', int(t['time'])))
for o in ord_data:
    all_times.append(('FUT', o['createTime']))
all_times.sort(key=lambda x: x[1])

print(f"\nFirst activity: {ts(all_times[0][1])} ({all_times[0][0]})")
print(f"Last activity: {ts(all_times[-1][1])} ({all_times[-1][0]})")

# Running PnL
print(f"\nSpot P&L: {net:.4f} USDT (minus comm {comm:.4f})")
print(f"Futures realized P&L: {total_realized_pnl:.4f} USDT")
print(f"COMBINED P&L: {net - comm + total_realized_pnl:.4f} USDT")
print(f"\nCurrent balance: ~22.7 USDT")
print(f"If started with $10 => net change = +12.7 USDT ??")
print(f"Or if started with more, net is loss pattern")

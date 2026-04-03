import json
from datetime import datetime, timezone
from collections import defaultdict

# Fix encoding
for name in ['razgon_all_positions', 'razgon_all_funding', 'razgon_all_orders']:
    fp = f'scripts/{name}.json'
    try:
        with open(fp, 'r', encoding='utf-8') as f:
            json.loads(f.read())
    except:
        with open(fp, 'r', encoding='utf-16') as f:
            data = json.loads(f.read())
        with open(fp, 'w', encoding='utf-8') as f:
            json.dump(data, f, indent=2)
        print(f'{name}: fixed')

positions = json.load(open('scripts/razgon_all_positions.json'))
funding = json.load(open('scripts/razgon_all_funding.json'))
spot = json.load(open('scripts/razgon_spot_trades.json'))

def ts(ms):
    return datetime.fromtimestamp(ms/1000, tz=timezone.utc)

def tss(ms):
    return ts(ms).strftime('%Y-%m-%d %H:%M:%S')

print("=" * 70)
print("COMPLETE RAZGON ANALYSIS")
print("=" * 70)

# ── FUNDING HISTORY — shows what symbols were traded and when ──
print("\n### FUNDING HISTORY (929 records) ###")
funding.sort(key=lambda f: f.get('settleTime', 0))

# Earliest and latest
if funding:
    print(f"Earliest funding: {tss(funding[0]['settleTime'])}")
    print(f"Latest funding: {tss(funding[-1]['settleTime'])}")

# Symbols in funding
fund_syms = defaultdict(list)
for f in funding:
    fund_syms[f['symbol']].append(f)

print(f"\nSymbols with funding records:")
for sym, records in sorted(fund_syms.items(), key=lambda x: min(r['settleTime'] for r in x[1])):
    times = [r['settleTime'] for r in records]
    total_funding = sum(r.get('funding', 0) for r in records)
    avg_val = sum(r.get('positionValue', 0) for r in records) / len(records)
    print(f"  {sym}: {len(records)} records, {tss(min(times))} -> {tss(max(times))}")
    print(f"    Total funding earned: {total_funding:.4f} USDT, avg position value: {avg_val:.2f} USDT")

# ── POSITIONS — full timeline ──
print("\n\n### POSITION HISTORY (100 positions) ###")
positions.sort(key=lambda p: p.get('openTime', p.get('createTime', 0)))

by_sym = defaultdict(list)
for p in positions:
    by_sym[p.get('symbol', '?')].append(p)

grand_pnl = 0
for sym in sorted(by_sym.keys()):
    pp = by_sym[sym]
    pnl = sum(p.get('realised', 0) for p in pp)
    grand_pnl += pnl
    times_open = [p.get('openTime', 0) for p in pp]
    times_close = [p.get('closeTime', 0) for p in pp]
    print(f"\n  {sym}: {len(pp)} positions")
    print(f"    Period: {tss(min(times_open))} -> {tss(max(times_close))}")
    print(f"    Realized PnL: {pnl:.4f} USDT")
    
    # Running PnL over time
    running = 0
    for p in pp:
        running += p.get('realised', 0)
        side = 'LONG' if p.get('positionType') == 1 else 'SHORT'
        lev = p.get('leverage', '?')
        rpnl = p.get('realised', 0)
        dur_sec = (p.get('closeTime', 0) - p.get('openTime', 0)) / 1000
        print(f"    {tss(p.get('openTime',0))} {side} {lev}x open={p.get('openAvgPrice','?')} close={p.get('closeAvgPrice','?')} PnL={rpnl:+.4f} running={running:+.4f} [{dur_sec:.0f}s]")

print(f"\n  GRAND TOTAL realized PnL: {grand_pnl:.4f} USDT")

# ── RECONSTRUCT TIMELINE — when did money first appear? ──
print("\n\n### TIMELINE RECONSTRUCTION ###")

# All events chronologically
events = []
for p in positions:
    events.append((p.get('openTime', 0), 'FUT_OPEN', p.get('symbol', ''), p.get('realised', 0)))
    events.append((p.get('closeTime', 0), 'FUT_CLOSE', p.get('symbol', ''), p.get('realised', 0)))

for t in spot:
    side = 'SPOT_BUY' if t['isBuyer'] else 'SPOT_SELL'
    events.append((int(t['time']), side, t['symbol'], float(t['quoteQty']) * (-1 if t['isBuyer'] else 1)))

events.sort(key=lambda x: x[0])
print(f"First event: {tss(events[0][0])} {events[0][1]} {events[0][2]}")
print(f"Last event: {tss(events[-1][0])} {events[-1][1]} {events[-1][2]}")

# Day-by-day summary
days = defaultdict(lambda: {'spot_buy': 0, 'spot_sell': 0, 'fut_pnl': 0, 'positions': 0, 'symbols': set()})
for p in positions:
    day = ts(p.get('openTime', 0)).strftime('%Y-%m-%d')
    days[day]['fut_pnl'] += p.get('realised', 0)
    days[day]['positions'] += 1
    days[day]['symbols'].add(p.get('symbol', '?'))

for t in spot:
    day = ts(int(t['time'])).strftime('%Y-%m-%d')
    if t['isBuyer']:
        days[day]['spot_buy'] += float(t['quoteQty'])
    else:
        days[day]['spot_sell'] += float(t['quoteQty'])

print("\nDay-by-day:")
for day in sorted(days.keys()):
    d = days[day]
    spot_net = d['spot_sell'] - d['spot_buy']
    print(f"  {day}: {d['positions']} fut positions, fut PnL={d['fut_pnl']:+.2f}, spot buy={d['spot_buy']:.0f} sell={d['spot_sell']:.0f} (net={spot_net:+.2f}), symbols={d['symbols']}")

# ── THE BIG QUESTION: where did money come from? ──
print("\n\n### BALANCE RECONSTRUCTION ###")
print("Current balance: 20.55 USDT (futures) + 0.10 USDC + ~2 PALMAI = ~22.7 USDT")
print(f"Total futures realized PnL: {grand_pnl:.4f} USDT")
spot_net = sum(float(t['quoteQty']) * (-1 if t['isBuyer'] else 1) for t in spot)
spot_comm = sum(float(t['commission']) for t in spot)
print(f"Total spot net (sells - buys): {spot_net:.4f} USDT")
print(f"Total spot commission: {spot_comm:.4f} USDT")
total_loss = grand_pnl + spot_net - spot_comm
print(f"Total combined P&L: {total_loss:.4f} USDT")
deposit_est = 22.7 - total_loss  # current_balance = deposit + pnl
print(f"\n=> Estimated initial deposit: ~{deposit_est:.1f} USDT")
print(f"   (current 22.7 = deposit {deposit_est:.1f} + losses {total_loss:.1f})")

# ── FUNDING TOTAL ──
total_funding = sum(f.get('funding', 0) for f in funding)
print(f"\nTotal funding payments received: {total_funding:.4f} USDT")

# ── When first funding? ──
if funding:
    first_fund = ts(funding[0]['settleTime'])
    print(f"First funding: {first_fund.strftime('%Y-%m-%d %H:%M:%S')} ({funding[0]['symbol']})")
    last_fund = ts(funding[-1]['settleTime'])
    print(f"Last funding: {last_fund.strftime('%Y-%m-%d %H:%M:%S')} ({funding[-1]['symbol']})")

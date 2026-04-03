#!/usr/bin/env python3
"""
Разгон MEXC — Полный кросс-анализ v3
Анализ: спот трейдинг, фьючерсы, переводы, funding, баланс, тайминг
"""
import json, os, sys
from datetime import datetime, timezone
from collections import defaultdict

DIR = os.path.join(os.path.dirname(__file__), 'razgon_v3')

def load(name):
    fp = os.path.join(DIR, name)
    try:
        with open(fp, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (UnicodeDecodeError, json.JSONDecodeError):
        with open(fp, 'r', encoding='utf-16') as f:
            text = f.read()
        return json.loads(text)

def ts_to_dt(ms):
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)

def ts_fmt(ms):
    return ts_to_dt(ms).strftime('%Y-%m-%d %H:%M:%S')

# ============================================================
# 1. LOAD DATA
# ============================================================
print("=" * 70)
print("РАЗГОН MEXC — ПОЛНЫЙ КРОСС-АНАЛИЗ v3")
print("=" * 70)

spot_trades = load('spot_all_trades.json')
positions = load('futures_all_positions.json')
funding = load('futures_all_funding.json')
orders = load('futures_all_orders.json')

# Transfers - handle nested format
transfers_f2s_raw = load('transfers_futures_to_spot.json')
transfers_s2f_raw = load('transfers_spot_to_futures.json')
transfers_f2s = transfers_f2s_raw.get('rows', transfers_f2s_raw) if isinstance(transfers_f2s_raw, dict) else transfers_f2s_raw
transfers_s2f = transfers_s2f_raw.get('rows', transfers_s2f_raw) if isinstance(transfers_s2f_raw, dict) else transfers_s2f_raw

print(f"\nLoaded: {len(spot_trades)} spot trades, {len(positions)} positions, "
      f"{len(funding)} funding, {len(orders)} orders")
print(f"Transfers: {len(transfers_f2s)} fut→spot, {len(transfers_s2f)} spot→fut")

# ============================================================
# 2. SPOT TRADES ANALYSIS
# ============================================================
print("\n" + "=" * 70)
print("2. СПОТ ТРЕЙДЫ")
print("=" * 70)

spot_by_symbol = defaultdict(list)
for t in spot_trades:
    spot_by_symbol[t['symbol']].append(t)

for sym, trades in sorted(spot_by_symbol.items()):
    buys = [t for t in trades if t['isBuyer']]
    sells = [t for t in trades if not t['isBuyer']]
    buy_vol = sum(float(t['quoteQty']) for t in buys)
    sell_vol = sum(float(t['quoteQty']) for t in sells)
    comm = sum(float(t['commission']) for t in trades)
    times = [t['time'] for t in trades]
    self_trades = [t for t in trades if t.get('isSelfTrade')]
    
    print(f"\n  {sym}:")
    print(f"    Трейдов: {len(trades)} (buy={len(buys)}, sell={len(sells)})")
    print(f"    Период: {ts_fmt(min(times))} → {ts_fmt(max(times))}")
    duration_s = (max(times) - min(times)) / 1000
    print(f"    Длительность: {duration_s:.0f}с ({duration_s/60:.1f} мин)")
    print(f"    Объём: buy={buy_vol:.2f} USDT, sell={sell_vol:.2f} USDT")
    print(f"    Net (sell-buy): {sell_vol - buy_vol:.4f} USDT")
    print(f"    Комиссия: {comm:.4f} USDT")
    print(f"    Self-trades: {len(self_trades)}")
    
    # Timing analysis  
    if len(trades) > 1:
        intervals = []
        sorted_trades = sorted(trades, key=lambda t: t['time'])
        for i in range(1, len(sorted_trades)):
            intervals.append(sorted_trades[i]['time'] - sorted_trades[i-1]['time'])
        avg_interval = sum(intervals) / len(intervals)
        min_interval = min(intervals)
        print(f"    Интервалы: avg={avg_interval:.0f}ms, min={min_interval}ms")
        
    # Check price spread
    prices = [float(t['price']) for t in trades]
    print(f"    Цена: min={min(prices)}, max={max(prices)}, "
          f"spread={((max(prices)-min(prices))/min(prices))*100:.2f}%")

# ============================================================
# 3. ФЬЮЧЕРСНЫЕ ПОЗИЦИИ
# ============================================================
print("\n" + "=" * 70)
print("3. ФЬЮЧЕРСНЫЕ ПОЗИЦИИ")
print("=" * 70)

pos_by_symbol = defaultdict(list)
for p in positions:
    pos_by_symbol[p['symbol']].append(p)

total_realized = 0
for sym, pos_list in sorted(pos_by_symbol.items()):
    pos_list.sort(key=lambda p: p['createTime'])
    realized = sum(p.get('closeProfitLoss', 0) for p in pos_list)
    total_realized += realized
    
    # Win/loss stats
    wins = [p for p in pos_list if p.get('closeProfitLoss', 0) > 0]
    losses = [p for p in pos_list if p.get('closeProfitLoss', 0) < 0]
    even = [p for p in pos_list if p.get('closeProfitLoss', 0) == 0]
    
    print(f"\n  {sym}: {len(pos_list)} позиций")
    print(f"    Период: {ts_fmt(pos_list[0]['createTime'])} → {ts_fmt(pos_list[-1]['updateTime'])}")
    print(f"    P&L: {realized:+.4f} USDT")
    print(f"    Win/Loss/Even: {len(wins)}/{len(losses)}/{len(even)}")
    if wins:
        print(f"    Avg win: {sum(p['closeProfitLoss'] for p in wins)/len(wins):.4f}")
    if losses:
        print(f"    Avg loss: {sum(p['closeProfitLoss'] for p in losses)/len(losses):.4f}")
    
    # Leverage and direction
    leverages = set(p.get('leverage', 0) for p in pos_list)
    # positionType: 1=LONG, 2=SHORT
    longs = len([p for p in pos_list if p.get('positionType') == 1])
    shorts = len([p for p in pos_list if p.get('positionType') == 2])
    print(f"    Leverage: {leverages}")
    print(f"    Long/Short: {longs}/{shorts}")
    
    # Duration stats
    durations = [(p['updateTime'] - p['createTime'])/1000 for p in pos_list]
    if any(d > 0 for d in durations):
        valid_d = [d for d in durations if d > 0]
        print(f"    Длительность (с): avg={sum(valid_d)/len(valid_d):.0f}, "
              f"min={min(valid_d):.0f}, max={max(valid_d):.0f}")
    
    # Detail first 5 and last 5
    print(f"    --- Первые 3 ---")
    for p in pos_list[:3]:
        dt = (p['updateTime'] - p['createTime'])/1000
        side = "LONG" if p.get('positionType') == 1 else "SHORT"
        print(f"      {ts_fmt(p['createTime'])} {side} {p.get('leverage',0)}x "
              f"open={p.get('openAvgPrice',0)} close={p.get('closeAvgPrice',0)} "
              f"PnL={p.get('closeProfitLoss',0):+.4f} dur={dt:.0f}s")
    if len(pos_list) > 6:
        print(f"    ... ({len(pos_list)-6} позиций пропущено) ...")
    print(f"    --- Последние 3 ---")
    for p in pos_list[-3:]:
        dt = (p['updateTime'] - p['createTime'])/1000
        side = "LONG" if p.get('positionType') == 1 else "SHORT"
        print(f"      {ts_fmt(p['createTime'])} {side} {p.get('leverage',0)}x "
              f"open={p.get('openAvgPrice',0)} close={p.get('closeAvgPrice',0)} "
              f"PnL={p.get('closeProfitLoss',0):+.4f} dur={dt:.0f}s")

print(f"\n  ИТОГО realized PnL (фьючерсы): {total_realized:+.4f} USDT")

# ============================================================
# 4. КРОСС-АНАЛИЗ: СПОТ vs ФЬЮЧЕРСЫ ТАЙМИНГ
# ============================================================
print("\n" + "=" * 70)
print("4. КРОСС-АНАЛИЗ: ТАЙМИНГ СПОТ vs ФЬЮЧЕРСЫ")
print("=" * 70)

# Get all spot trade timestamps
spot_times = sorted([t['time'] for t in spot_trades])
# Get all position open/close timestamps
pos_events = []
for p in positions:
    pos_events.append(('OPEN', p['createTime'], p['symbol'], p.get('positionType')))
    pos_events.append(('CLOSE', p['updateTime'], p['symbol'], p.get('closeProfitLoss', 0)))
pos_events.sort(key=lambda x: x[1])

if spot_times and pos_events:
    spot_start = min(spot_times)
    spot_end = max(spot_times)
    pos_start = min(e[1] for e in pos_events)
    pos_end = max(e[1] for e in pos_events)
    
    print(f"\n  Спот активность: {ts_fmt(spot_start)} → {ts_fmt(spot_end)}")
    print(f"  Фьючерс активность: {ts_fmt(pos_start)} → {ts_fmt(pos_end)}")
    
    # Check for overlapping periods
    overlap_start = max(spot_start, pos_start)
    overlap_end = min(spot_end, pos_end)
    if overlap_start < overlap_end:
        print(f"  ⚡ ПЕРЕСЕЧЕНИЕ: {ts_fmt(overlap_start)} → {ts_fmt(overlap_end)}")
        
        # Find spot trades during futures activity
        during_futures = [t for t in spot_trades if pos_start <= t['time'] <= pos_end]
        print(f"  Спот трейдов во время фьючерсной активности: {len(during_futures)}")
        
        # Find futures positions during spot activity
        during_spot = [p for p in positions if spot_start <= p['createTime'] <= spot_end]
        print(f"  Позиций фьючерс во время спот активности: {len(during_spot)}")
    else:
        print(f"  ❌ НЕТ ПЕРЕСЕЧЕНИЯ по времени")
        gap = (overlap_start - overlap_end) / 1000 / 3600
        print(f"     Разрыв: {gap:.1f} часов")
        
    # Detailed: group by day
    print(f"\n  --- Дневная разбивка ---")
    all_events = []
    for t in spot_trades:
        all_events.append(('SPOT', t['time'], t['symbol'], 
                          'BUY' if t['isBuyer'] else 'SELL', float(t['quoteQty'])))
    for p in positions:
        side = 'LONG' if p.get('positionType') == 1 else 'SHORT'
        all_events.append(('FUT_OPEN', p['createTime'], p['symbol'], side, 0))
        all_events.append(('FUT_CLOSE', p['updateTime'], p['symbol'], 
                          f"PnL={p.get('closeProfitLoss',0):+.4f}", 0))
    all_events.sort(key=lambda x: x[1])
    
    by_day = defaultdict(list)
    for e in all_events:
        day = ts_to_dt(e[1]).strftime('%Y-%m-%d')
        by_day[day].append(e)
    
    for day in sorted(by_day.keys()):
        events = by_day[day]
        spot_cnt = len([e for e in events if e[0] == 'SPOT'])
        fut_open = len([e for e in events if e[0] == 'FUT_OPEN'])
        fut_close = len([e for e in events if e[0] == 'FUT_CLOSE'])
        spot_vol = sum(e[4] for e in events if e[0] == 'SPOT')
        syms = set(e[2] for e in events)
        print(f"    {day}: spot={spot_cnt} ({spot_vol:.1f}$), "
              f"fut_open={fut_open}, fut_close={fut_close}, symbols={syms}")

# ============================================================
# 5. ПЕРЕВОДЫ (FUND FLOW)
# ============================================================
print("\n" + "=" * 70)
print("5. ПЕРЕВОДЫ МЕЖДУ СЧЕТАМИ")
print("=" * 70)

total_f2s = 0
total_s2f = 0

print(f"\n  Futures → Spot ({len(transfers_f2s)} переводов):")
for t in sorted(transfers_f2s, key=lambda x: x['timestamp']):
    amt = float(t['amount'])
    total_f2s += amt
    print(f"    {ts_fmt(t['timestamp'])} +{amt:.2f} USDT")
print(f"  ИТОГО fut→spot: {total_f2s:.2f} USDT")

print(f"\n  Spot → Futures ({len(transfers_s2f)} переводов):")
for t in sorted(transfers_s2f, key=lambda x: x['timestamp']):
    amt = float(t['amount'])
    total_s2f += amt
    print(f"    {ts_fmt(t['timestamp'])} +{amt:.2f} USDT")
print(f"  ИТОГО spot→fut: {total_s2f:.2f} USDT")

net_to_spot = total_f2s - total_s2f
print(f"\n  NET в спот: {net_to_spot:+.2f} USDT")

# ============================================================
# 6. FUNDING
# ============================================================
print("\n" + "=" * 70)
print("6. FUNDING PAYMENTS")
print("=" * 70)

fund_by_symbol = defaultdict(list)
for f in funding:
    sym = f.get('symbol', 'unknown')
    fund_by_symbol[sym].append(f)

total_funding = 0
print(f"\n  Символов с funding: {len(fund_by_symbol)}")
top_funding = []
for sym, recs in fund_by_symbol.items():
    earned = sum(float(r.get('funding', 0)) for r in recs)
    total_funding += earned
    top_funding.append((sym, earned, len(recs)))

top_funding.sort(key=lambda x: abs(x[1]), reverse=True)
print(f"\n  ТОП-15 по funding:")
for sym, earned, cnt in top_funding[:15]:
    print(f"    {sym}: {earned:+.4f} USDT ({cnt} записей)")

print(f"\n  ИТОГО funding: {total_funding:+.4f} USDT")

# ============================================================
# 7. БАЛАНС / P&L РЕКОНСТРУКЦИЯ
# ============================================================
print("\n" + "=" * 70)
print("7. РЕКОНСТРУКЦИЯ БАЛАНСА И P&L")
print("=" * 70)

# Spot P&L
spot_buy_total = sum(float(t['quoteQty']) for t in spot_trades if t['isBuyer'])
spot_sell_total = sum(float(t['quoteQty']) for t in spot_trades if not t['isBuyer'])
spot_commission = sum(float(t['commission']) for t in spot_trades)
spot_net = spot_sell_total - spot_buy_total
spot_pnl = spot_net - spot_commission

print(f"\n  Спот:")
print(f"    Покупки: {spot_buy_total:.4f} USDT")
print(f"    Продажи: {spot_sell_total:.4f} USDT")
print(f"    Net: {spot_net:+.4f} USDT")
print(f"    Комиссия: {spot_commission:.4f} USDT")
print(f"    P&L (net - comm): {spot_pnl:+.4f} USDT")

print(f"\n  Фьючерсы:")
print(f"    Realized PnL: {total_realized:+.4f} USDT")
print(f"    Funding earned: {total_funding:+.4f} USDT")
print(f"    Комбинированный фьючерсный P&L: {total_realized + total_funding:+.4f} USDT")

combined = spot_pnl + total_realized + total_funding
print(f"\n  ОБЩИЙ P&L:")
print(f"    Спот P&L: {spot_pnl:+.4f}")
print(f"    Futures realized: {total_realized:+.4f}")
print(f"    Funding: {total_funding:+.4f}")
print(f"    ━━━━━━━━━━━━━━━━━━━━━━━━━")
print(f"    ИТОГО: {combined:+.4f} USDT")

print(f"\n  Текущий баланс: ~20.55 USDT (фьючерсы) + ~0 спот")
print(f"  Вывод fut→spot: {total_f2s:.2f} USDT (использовано для спот-торговли)")
print(f"  Возврат spot→fut: {total_s2f:.2f} USDT")
print(f"\n  Оценка начального депозита:")
print(f"    current_balance + losses - funding - net_transfers")
print(f"    = 20.55 + ({-combined:.2f}) - ({net_to_spot:.2f})")

# Better estimation: 
# starting_futures = current_futures + |futures_realized| + transfers_f2s - transfers_s2f - funding
est_deposit = 20.55 + abs(total_realized) + total_f2s - total_s2f - total_funding + abs(spot_pnl)
print(f"    ≈ {est_deposit:.2f} USDT")

# ============================================================
# 8. ПАТТЕРН: МУЛЬТИ-АККАУНТ ИЛИ ОДИНОЧНЫЙ?
# ============================================================
print("\n" + "=" * 70)
print("8. АНАЛИЗ: ОДИНОЧНЫЙ vs МУЛЬТИ-АККАУНТ")
print("=" * 70)

# Indicators:
# 1. Self-trade flag на споте
self_trade_count = len([t for t in spot_trades if t.get('isSelfTrade')])
print(f"\n  isSelfTrade на споте: {self_trade_count}/{len(spot_trades)}")

# 2. Спот: buy и sell в одну секунду (wash trading pattern)
spot_sorted = sorted(spot_trades, key=lambda t: t['time'])
wash_pairs = 0
for i in range(len(spot_sorted) - 1):
    t1, t2 = spot_sorted[i], spot_sorted[i+1]
    if abs(t1['time'] - t2['time']) <= 1000 and t1['isBuyer'] != t2['isBuyer']:
        wash_pairs += 1
print(f"  Buy+Sell в пределах 1с: {wash_pairs} пар (из {len(spot_trades)} трейдов)")

# 3. Futures: only maker fee = 0 (MEXC zero-fee maker)
zero_fee_pos = len([p for p in positions if p.get('totalFee', 0) == 0])
print(f"  Позиции с нулевой комиссией: {zero_fee_pos}/{len(positions)}")

# 4. Consistent position sizes
position_sizes = defaultdict(list)
for p in positions:
    position_sizes[p['symbol']].append(p.get('closeVol', 0))
for sym, sizes in position_sizes.items():
    if len(sizes) > 5:
        avg = sum(sizes) / len(sizes)
        std = (sum((s-avg)**2 for s in sizes) / len(sizes)) ** 0.5
        print(f"  {sym} volume: avg={avg:.0f}, std={std:.0f}, "
              f"CV={std/avg if avg else 0:.2%}")

# 5. Time gaps between positions
print(f"\n  --- Расписание торговли ---")
by_hour = defaultdict(int)
for p in positions:
    h = ts_to_dt(p['createTime']).hour
    by_hour[h] += 1
for t in spot_trades:
    h = ts_to_dt(t['time']).hour
    by_hour[h] += 1
print(f"  Активность по часам (UTC):")
for h in sorted(by_hour.keys()):
    bar = '█' * (by_hour[h] // 2)
    print(f"    {h:02d}:00  {by_hour[h]:4d}  {bar}")

# ============================================================
# 9. ВЫВОД: СТРАТЕГИЯ "РАЗГОН"
# ============================================================
print("\n" + "=" * 70)
print("9. ВЫВОД: КАК РАБОТАЕТ СТРАТЕГИЯ")
print("=" * 70)

# ============================================================
# 10. ХРОНОЛОГИЯ СОБЫТИЙ (полная)
# ============================================================
print("\n" + "=" * 70)
print("10. ПОЛНАЯ ХРОНОЛОГИЯ СОБЫТИЙ")
print("=" * 70)

timeline = []

# Add transfers
for t in transfers_f2s:
    timeline.append((t['timestamp'], 'TRANSFER', f"Futures→Spot {float(t['amount']):.2f} USDT"))
for t in transfers_s2f:
    timeline.append((t['timestamp'], 'TRANSFER', f"Spot→Futures {float(t['amount']):.2f} USDT"))

# Add first/last spot trade per day
spot_by_day = defaultdict(list)
for t in spot_trades:
    day = ts_to_dt(t['time']).strftime('%Y-%m-%d')
    spot_by_day[day].append(t)
for day, trades in spot_by_day.items():
    trades.sort(key=lambda t: t['time'])
    buy_vol = sum(float(t['quoteQty']) for t in trades if t['isBuyer'])
    sell_vol = sum(float(t['quoteQty']) for t in trades if not t['isBuyer'])
    timeline.append((trades[0]['time'], 'SPOT_SESSION', 
                     f"{day}: {len(trades)} trades, buy={buy_vol:.1f}$, sell={sell_vol:.1f}$"))

# Add positions (grouped by symbol+day)
pos_by_sym_day = defaultdict(list)
for p in positions:
    day = ts_to_dt(p['createTime']).strftime('%Y-%m-%d')
    pos_by_sym_day[(p['symbol'], day)].append(p)

for (sym, day), plist in pos_by_sym_day.items():
    pnl = sum(p.get('closeProfitLoss', 0) for p in plist)
    timeline.append((plist[0]['createTime'], 'FUT_SESSION', 
                     f"{day} {sym}: {len(plist)} positions, PnL={pnl:+.2f}$"))

timeline.sort(key=lambda x: x[0])
for ts, etype, desc in timeline:
    marker = {'TRANSFER': '💰', 'SPOT_SESSION': '📊', 'FUT_SESSION': '📈'}.get(etype, '❓')
    print(f"  {ts_fmt(ts)} {marker} [{etype}] {desc}")

print("\n" + "=" * 70)
print("АНАЛИЗ ЗАВЕРШЁН")
print("=" * 70)

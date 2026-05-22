import requests
import json
from datetime import datetime, timedelta

# FETUSDT DCA backtest
symbol = 'FETUSDT'
start_date = '2024-01-01'
end_date = '2024-12-31'

# DCA config (from previous)
base_amount_usdt = 10
step_percent = 5
max_steps = 5
tp_percent = 10
sl_percent = -20

# Get candles from Bybit
url = f'https://api.bybit.com/v5/market/kline?category=linear&symbol={symbol}&interval=D&start={int(datetime.strptime(start_date, "%Y-%m-%d").timestamp() * 1000)}&end={int(datetime.strptime(end_date, "%Y-%m-%d").timestamp() * 1000)}'
response = requests.get(url)
data = response.json()

if data['retCode'] != 0:
    print('Error fetching candles:', data)
    exit()

candles = data['result']['list']
candles.reverse()  # oldest first

# Simulate DCA
position = {'qty': 0, 'avg_price': 0, 'total_cost': 0, 'steps': 0}
trades = []
pnl = 0

for candle in candles:
    close = float(candle[4])
    
    # Trigger DCA on downtrend (close < avg_price * 0.95 or initial)
    if position['steps'] == 0 or (position['steps'] > 0 and close < position['avg_price'] * (1 - step_percent/100)):
        if position['steps'] < max_steps:
            amount = base_amount_usdt * (1 + position['steps'] * step_percent/100)
            qty = amount / close
            position['qty'] += qty
            position['total_cost'] += amount
            position['avg_price'] = position['total_cost'] / position['qty']
            position['steps'] += 1
            trades.append({'type': 'buy', 'price': close, 'qty': qty, 'step': position['steps']})
    
    # Check TP/SL
    if position['steps'] > 0:
        current_pnl = (close - position['avg_price']) / position['avg_price'] * 100
        if current_pnl >= tp_percent or current_pnl <= sl_percent:
            pnl += (close * position['qty']) - position['total_cost']
            trades.append({'type': 'close', 'price': close, 'qty': position['qty'], 'pnl': pnl})
            position = {'qty': 0, 'avg_price': 0, 'total_cost': 0, 'steps': 0}

print(f'FETUSDT DCA Backtest: {len(trades)} trades, PnL: ${pnl:.2f}')
for trade in trades[-5:]:  # last 5
    print(trade)

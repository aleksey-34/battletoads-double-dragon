import requests
from datetime import datetime

pairs = ['FETUSDT', 'OPUSDT']
start_date = '2024-01-01'
end_date = '2024-12-31'
base_amount_usdt = 10
step_percent = 5
max_steps = 5
tp_percent = 10
sl_percent = -20


def fetch_binance(symbol):
    start_ts = int(datetime.strptime(start_date, '%Y-%m-%d').timestamp() * 1000)
    end_ts = int(datetime.strptime(end_date, '%Y-%m-%d').timestamp() * 1000)
    url = f'https://api.binance.com/api/v3/klines?symbol={symbol}&interval=1d&startTime={start_ts}&endTime={end_ts}&limit=1000'
    r = requests.get(url, timeout=20)
    data = r.json()
    if isinstance(data, dict) and data.get('code'):
        raise RuntimeError(data)
    return data


def run_long_only(candles):
    pos = {'qty': 0, 'entry': 0, 'cost': 0, 'steps': 0}
    trades = []
    pnl = 0
    for c in candles:
        close = float(c[4])
        if pos['steps'] == 0 or (pos['steps'] > 0 and close < pos['entry'] * (1 - step_percent / 100)):
            if pos['steps'] < max_steps:
                amount = base_amount_usdt * (1 + pos['steps'] * step_percent / 100)
                qty = amount / close
                pos['qty'] += qty
                pos['cost'] += amount
                pos['entry'] = pos['cost'] / pos['qty']
                pos['steps'] += 1
                trades.append(('buy', close, qty, pos['steps']))
        if pos['steps'] > 0:
            cur = (close - pos['entry']) / pos['entry'] * 100
            if cur >= tp_percent or cur <= sl_percent:
                pnl += (close * pos['qty'] - pos['cost'])
                trades.append(('close', close, pos['qty'], cur))
                pos = {'qty': 0, 'entry': 0, 'cost': 0, 'steps': 0}
    return pnl, len(trades)


def run_long_short(candles):
    pos = {'qty': 0, 'entry': 0, 'cost': 0, 'steps': 0, 'side': None}
    trades = []
    pnl = 0
    prev_close = None
    for c in candles:
        close = float(c[4])
        if pos['steps'] > 0:
            if pos['side'] == 'long':
                cur = (close - pos['entry']) / pos['entry'] * 100
                if cur >= tp_percent or cur <= sl_percent:
                    pnl += (close * pos['qty'] - pos['cost'])
                    trades.append(('close_long', close, pos['qty'], cur))
                    pos = {'qty': 0, 'entry': 0, 'cost': 0, 'steps': 0, 'side': None}
                elif close < pos['entry'] * (1 - step_percent / 100) and pos['steps'] < max_steps:
                    amount = base_amount_usdt * (1 + pos['steps'] * step_percent / 100)
                    qty = amount / close
                    pos['qty'] += qty
                    pos['cost'] += amount
                    pos['entry'] = pos['cost'] / pos['qty']
                    pos['steps'] += 1
                    trades.append(('add_long', close, qty, pos['steps']))
            else:
                cur = (pos['entry'] - close) / pos['entry'] * 100
                if cur >= tp_percent or cur <= sl_percent:
                    pnl += (pos['cost'] - close * pos['qty'])
                    trades.append(('close_short', close, pos['qty'], cur))
                    pos = {'qty': 0, 'entry': 0, 'cost': 0, 'steps': 0, 'side': None}
                elif close > pos['entry'] * (1 + step_percent / 100) and pos['steps'] < max_steps:
                    amount = base_amount_usdt * (1 + pos['steps'] * step_percent / 100)
                    qty = amount / close
                    pos['qty'] += qty
                    pos['cost'] += amount
                    pos['entry'] = pos['cost'] / pos['qty']
                    pos['steps'] += 1
                    trades.append(('add_short', close, qty, pos['steps']))
        if pos['steps'] == 0 and prev_close is not None:
            if close >= prev_close * (1 + step_percent / 100):
                amount = base_amount_usdt
                qty = amount / close
                pos = {'qty': qty, 'entry': close, 'cost': amount, 'steps': 1, 'side': 'short'}
                trades.append(('open_short', close, qty, 1))
            elif close <= prev_close * (1 - step_percent / 100):
                amount = base_amount_usdt
                qty = amount / close
                pos = {'qty': qty, 'entry': close, 'cost': amount, 'steps': 1, 'side': 'long'}
                trades.append(('open_long', close, qty, 1))
        prev_close = close
    return pnl, len(trades)


for symbol in pairs:
    candles = fetch_binance(symbol)
    lo = run_long_only(candles)
    ls = run_long_short(candles)
    print(symbol, 'long-only PnL=', round(lo[0], 2), 'trades=', lo[1], 'long+short PnL=', round(ls[0], 2), 'trades=', ls[1])

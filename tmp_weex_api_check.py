import json, urllib.request, ssl

ctx = ssl.create_default_context()

# 1. Check exchangeInfo (full market data)
print('=== Checking WEEX API endpoints ===\n')

# Try v3 exchangeInfo
try:
    resp = urllib.request.urlopen('https://api-contract.weex.com/capi/v3/market/exchangeInfo', timeout=30, context=ctx)
    data = json.loads(resp.read())
    symbols = data.get('data', {}).get('symbols', []) if isinstance(data.get('data'), dict) else []
    if not symbols:
        symbols = data.get('symbols', [])
    print(f'v3/exchangeInfo: {len(symbols)} symbols')
    if symbols:
        s = symbols[0]
        print(f'  Sample keys: {list(s.keys())[:15]}')
        print(f'  Sample: {s.get("symbol")} status={s.get("status")} maxLev={s.get("maxLeverage")}')
        # Count active
        active = [s for s in symbols if s.get('status') not in ('offline', 'suspend', 'halt')]
        print(f'  Active: {len(active)}')
        usdt_active = [s for s in active if str(s.get("symbol","")).upper().endswith('USDT')]
        print(f'  Active USDT: {len(usdt_active)}')
except Exception as e:
    print(f'v3/exchangeInfo FAILED: {e}')
    symbols = []

# 2. Check tickers
try:
    resp = urllib.request.urlopen('https://api-contract.weex.com/capi/v2/market/tickers', timeout=30, context=ctx)
    tdata = json.loads(resp.read())
    tickers = tdata if isinstance(tdata, list) else tdata.get('data', [])
    usdt_tickers = [t for t in tickers if str(t.get('symbol','')).endswith('usdt')]
    print(f'\nv2/tickers: {len(tickers)} total, {len(usdt_tickers)} USDT')
except Exception as e:
    print(f'v2/tickers FAILED: {e}')
    usdt_tickers = []

# 3. Check v3 API version / new endpoints
for ep in ['/capi/v3/market/tickers', '/capi/v3/market/contracts']:
    try:
        resp = urllib.request.urlopen(f'https://api-contract.weex.com{ep}', timeout=10, context=ctx)
        data = json.loads(resp.read())
        code = data.get('code', data.get('retCode', '?'))
        print(f'\n{ep}: code={code}, keys={list(data.keys())[:5]}')
        if data.get('data'):
            d = data['data']
            if isinstance(d, list):
                print(f'  {len(d)} items')
            elif isinstance(d, dict) and d.get('symbols'):
                print(f'  {len(d["symbols"])} symbols')
    except Exception as e:
        print(f'{ep}: {e}')

# 4. Check if candles work for a random non-whitelist pair
print('\n=== Testing API access for non-whitelist pairs ===')
test_pairs = ['cmt_arbusdt', 'cmt_algousdt', 'cmt_1inchusdt', 'cmt_bluaiusdt']
for sym in test_pairs:
    try:
        url = f'https://api-contract.weex.com/capi/v2/market/candles?symbol={sym}&granularity=1m&limit=3'
        resp = urllib.request.urlopen(url, timeout=10, context=ctx)
        data = json.loads(resp.read())
        candles = data.get('data', data) if not isinstance(data, list) else data
        if isinstance(candles, list) and len(candles) > 0:
            print(f'  {sym}: OK ({len(candles)} candles)')
        else:
            print(f'  {sym}: empty response: {str(data)[:100]}')
    except Exception as e:
        print(f'  {sym}: FAIL: {e}')

# 5. Compare exchangeInfo vs tickers
if symbols and usdt_tickers:
    ei_syms = set(str(s.get('symbol','')).upper() for s in symbols if str(s.get('symbol','')).upper().endswith('USDT'))
    tk_syms = set(str(t.get('symbol','')).replace('cmt_','').upper() for t in usdt_tickers)
    print(f'\nexchangeInfo USDT: {len(ei_syms)}')
    print(f'tickers USDT: {len(tk_syms)}')
    in_ei_not_tk = ei_syms - tk_syms
    in_tk_not_ei = tk_syms - ei_syms
    if in_ei_not_tk: print(f'  In exchangeInfo but NOT tickers ({len(in_ei_not_tk)}): {sorted(in_ei_not_tk)[:10]}...')
    if in_tk_not_ei: print(f'  In tickers but NOT exchangeInfo ({len(in_tk_not_ei)}): {sorted(in_tk_not_ei)[:10]}...')

# 6. Full valid list output
all_valid = sorted(tk_syms) if usdt_tickers else sorted(ei_syms)
print(f'\n=== FULL VALID USDT PAIRS ({len(all_valid)}) ===')
print(json.dumps(all_valid))

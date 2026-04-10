import json, sys, urllib.request

resp = urllib.request.urlopen('https://api-contract.weex.com/capi/v2/market/tickers')
data = json.loads(resp.read())
syms = sorted(set(
    s['symbol'].replace('cmt_','').upper()
    for s in data
    if s.get('symbol','').endswith('usdt')
))
print(f'Total WEEX USDT pairs: {len(syms)}')

local = ["1000BONKUSDT","1000PEPEUSDT","1000SHIBUSDT","AAVEUSDT","ADAUSDT","AEROUSDT","AGLDUSDT","APEUSDT","APTUSDT","ARKMUSDT","ATOMUSDT","AVAXUSDT","AXSUSDT","BANDUSDT","BCHUSDT","BNBUSDT","BTCUSDT","COMPUSDT","COWUSDT","CRVUSDT","CVXUSDT","DASHUSDT","DOGEUSDT","DOTUSDT","DUSKUSDT","ENSUSDT","ETCUSDT","ETHUSDT","FARTCOINUSDT","HBARUSDT","HYPEUSDT","ICPUSDT","IPUSDT","JASMYUSDT","JELLYJELLYUSDT","JTOUSDT","KASUSDT","LDOUSDT","LINKUSDT","LTCUSDT","LYNUSDT","NEARUSDT","NEOUSDT","ONDOUSDT","OPUSDT","ORDIUSDT","PAXGUSDT","PENGUUSDT","PUMPUSDT","QNTUSDT","RENDERUSDT","SEIUSDT","SOLUSDT","SSVUSDT","SUIUSDT","TAOUSDT","THETAUSDT","TIAUSDT","TONUSDT","TRBUSDT","TRUMPUSDT","TRXUSDT","UNIUSDT","VETUSDT","VIRTUALUSDT","WIFUSDT","WLDUSDT","XAGUSDT","XAUTUSDT","XLMUSDT","XRPUSDT","YFIUSDT","YGGUSDT","ZECUSDT","ZENUSDT"]

ws = set(syms)
ls = set(local)
both = [s for s in local if s in ws]
only_local = [s for s in local if s not in ws]
only_weex = sorted([s for s in syms if s not in ls])

print(f'Local file: {len(local)} pairs')
print(f'Matched (valid): {len(both)}')
print(f'\nIn file but NOT on WEEX ({len(only_local)}):')
for s in only_local: print(f'  ❌ {s}')
print(f'\nOn WEEX but NOT in file - new pairs ({len(only_weex)}):')
for s in only_weex: print(f'  ✅ {s}')

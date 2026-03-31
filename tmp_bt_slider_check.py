import json, urllib.request
headers = {'Authorization':'Bearer SuperSecure2026Admin!','Content-Type':'application/json'}
base = 'http://127.0.0.1:3001/api/saas/admin/sweep-backtest-preview'
def call(risk, freq):
    payload = {
        'kind':'algofund-ts',
        'systemName':'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v',
        'riskScore': risk,
        'tradeFrequencyScore': freq,
        'initialBalance': 10000,
        'riskScaleMaxPercent': 40,
    }
    req = urllib.request.Request(base, headers=headers, method='POST', data=json.dumps(payload).encode())
    with urllib.request.urlopen(req, timeout=120) as r:
        d = json.loads(r.read().decode())
    s = (d.get('preview') or {}).get('summary') or {}
    return {
      'risk': risk,
      'freq': freq,
      'selectedOffers': len(d.get('selectedOffers') or []),
      'source': (d.get('preview') or {}).get('source'),
      'trades': s.get('tradesCount'),
      'ret': s.get('totalReturnPercent'),
      'pf': s.get('profitFactor'),
      'dd': s.get('maxDrawdownPercent')
    }

for args in [(2,2),(5,5),(9,9),(9,2),(2,9)]:
    print(json.dumps(call(*args), ensure_ascii=False))

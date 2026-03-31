#!/usr/bin/env python3
import json
import urllib.request

BASE = 'http://127.0.0.1:3001/api/saas/admin/sweep-backtest-preview'
AUTH = {'Authorization': 'Bearer SuperSecure2026Admin!', 'Content-Type': 'application/json'}
SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'


def call(risk, freq, initial=10000, risk_cap=200):
    payload = {
        'kind': 'algofund-ts',
        'source': 'runtime_system',
        'systemName': SYSTEM,
        'riskScore': risk,
        'tradeFrequencyScore': freq,
        'initialBalance': initial,
        'riskScaleMaxPercent': risk_cap,
    }
    req = urllib.request.Request(BASE, data=json.dumps(payload).encode('utf-8'), headers=AUTH, method='POST')
    with urllib.request.urlopen(req, timeout=180) as r:
        data = json.loads(r.read().decode('utf-8'))
    s = (data.get('preview') or {}).get('summary') or {}
    return {
        'riskScore': risk,
        'tradeFrequencyScore': freq,
        'initialBalance': initial,
        'riskScaleMaxPercent': risk_cap,
        'source': (data.get('preview') or {}).get('source'),
        'selectedOffers': len(data.get('selectedOffers') or []),
        'ret': s.get('totalReturnPercent'),
        'dd': s.get('maxDrawdownPercent'),
        'pf': s.get('profitFactor'),
        'trades': s.get('tradesCount'),
        'finalEquity': s.get('finalEquity'),
    }

out = {
    'system': SYSTEM,
    'cases': [
        call(5, 5, 10000, 200),
        call(9, 7, 10000, 200),
    ],
}

print(json.dumps(out, ensure_ascii=False, indent=2))

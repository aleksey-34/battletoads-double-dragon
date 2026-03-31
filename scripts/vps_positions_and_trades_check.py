#!/usr/bin/env python3
import json
import urllib.parse
import urllib.request

BASE = 'http://127.0.0.1:3001/api'
AUTH = {'Authorization': 'Bearer SuperSecure2026Admin!'}
KEYS = ['HDB_18', 'BTDD_D1', 'Mehmet_Bingx', 'mustafa', 'HDB_15']


def get(path, params=None):
    url = f"{BASE}{path}"
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=AUTH)
    with urllib.request.urlopen(req, timeout=60) as r:
        return json.loads(r.read().decode('utf-8'))


out = {'keys': []}
for key in KEYS:
    positions = get(f"/positions/{urllib.parse.quote(key, safe='')}")
    trades = get(f"/trades/{urllib.parse.quote(key, safe='')}", {'limit': 50})
    out['keys'].append({
        'apiKey': key,
        'openPositionsCount': len(positions if isinstance(positions, list) else []),
        'tradesWithoutSymbolCount': len(trades if isinstance(trades, list) else []),
        'sampleTrade': (trades[0] if isinstance(trades, list) and trades else None),
    })

print(json.dumps(out, ensure_ascii=False, indent=2))

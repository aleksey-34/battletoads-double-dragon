#!/usr/bin/env python3
import json
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:3001'
AUTH = {'Authorization': 'Bearer SuperSecure2026Admin!'}
TARGET = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'


def get(path):
    req = urllib.request.Request(f"{BASE}{path}", headers=AUTH)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            body = r.read().decode('utf-8', errors='ignore')
            try:
                return {'ok': True, 'status': r.status, 'json': json.loads(body), 'text': body[:500]}
            except Exception:
                return {'ok': True, 'status': r.status, 'json': None, 'text': body[:500]}
    except urllib.error.HTTPError as e:
        body = e.read().decode('utf-8', errors='ignore')
        return {'ok': False, 'status': e.code, 'json': None, 'text': body[:1000]}
    except Exception as e:
        return {'ok': False, 'status': None, 'json': None, 'text': str(e)}

store = get('/api/saas/admin/offer-store')
snap = {}
if store['ok'] and isinstance(store.get('json'), dict):
    ts_map = (store['json'].get('tsBacktestSnapshots') or {})
    snap = ts_map.get(TARGET) or {}

positions = get('/api/positions/Mehmet_Bingx')
trades = get('/api/trades/Mehmet_Bingx?limit=20')

out = {
    'snapshot': {
        'trades': snap.get('trades'),
        'ret': snap.get('ret'),
        'dd': snap.get('dd'),
        'pf': snap.get('pf'),
        'updatedAt': snap.get('updatedAt'),
        'offerCount': len(snap.get('offerIds') or []),
        'backtestSettings': snap.get('backtestSettings'),
    },
    'mehmet_positions_api': {
        'ok': positions['ok'],
        'status': positions['status'],
        'text': positions['text'],
    },
    'mehmet_trades_api': {
        'ok': trades['ok'],
        'status': trades['status'],
        'text': trades['text'],
    },
}

print(json.dumps(out, ensure_ascii=False))

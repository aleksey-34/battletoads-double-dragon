#!/usr/bin/env python3
import json
import sqlite3
import urllib.request

DB = '/opt/battletoads-double-dragon/backend/database.db'
BASE = 'http://127.0.0.1:3001'
AUTH = {'Authorization': 'Bearer SuperSecure2026Admin!'}
TARGET = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()
rows = c.execute('''
SELECT t.id, t.slug, t.display_name,
       ap.execution_api_key_name, ap.published_system_name,
       ap.requested_enabled, ap.actual_enabled
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id=t.id
WHERE ap.published_system_name = ?
ORDER BY t.id
''', (TARGET,)).fetchall()

out = []
for r in rows:
    key = str(r['execution_api_key_name'] or '').strip()
    req = urllib.request.Request(f"{BASE}/api/positions/{urllib.parse.quote(key)}", headers=AUTH)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            body = resp.read().decode('utf-8', errors='ignore')
            try:
                arr = json.loads(body)
                cnt = len(arr) if isinstance(arr, list) else -1
            except Exception:
                cnt = -1
    except Exception:
        cnt = -1
    out.append({
        'tenantId': int(r['id']),
        'slug': r['slug'],
        'displayName': r['display_name'],
        'executionApiKey': key,
        'requestedEnabled': int(r['requested_enabled'] or 0),
        'actualEnabled': int(r['actual_enabled'] or 0),
        'openPositionsCount': cnt,
    })

print(json.dumps(out, ensure_ascii=False))

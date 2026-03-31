#!/usr/bin/env python3
import sqlite3
import json
import urllib.request

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
TARGET_SLUGS = ['mehmet-bingx', 'btdd-d1', 'ruslan', 'ali', 'mustafa']
API_URL = 'http://127.0.0.1:3001/api/saas/admin/algofund-batch-actions'
API_TOKEN = 'SuperSecure2026Admin!'

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
c = conn.cursor()

print('=== STEP 1: detect clients not running ===')
q = '''SELECT t.id AS tenant_id, t.slug, ap.id AS profile_id,
              COALESCE(ap.published_system_name,'') AS published_system_name,
              COALESCE(ap.requested_enabled,0) AS requested_enabled,
              COALESCE(ap.actual_enabled,0) AS actual_enabled
       FROM tenants t
       JOIN algofund_profiles ap ON ap.tenant_id = t.id
       WHERE lower(t.slug) IN ({})
       ORDER BY t.id'''.format(','.join(['?'] * len(TARGET_SLUGS)))
rows = c.execute(q, tuple(TARGET_SLUGS)).fetchall()

missing_runtime = []
profile_ids = []
for r in rows:
    profile_ids.append(int(r['profile_id']))
    running = int(r['requested_enabled']) == 1 and int(r['actual_enabled']) == 1
    bound = str(r['published_system_name']).strip() == TARGET_SYSTEM
    print(f"tenant={r['tenant_id']} slug={r['slug']} bound={bound} requested={r['requested_enabled']} actual={r['actual_enabled']}")
    if (not running) and bound:
        missing_runtime.append(int(r['tenant_id']))

print('\n=== STEP 2: start missing clients via direct batch start ===')
if missing_runtime:
    payload = {
        'tenantIds': missing_runtime,
        'requestType': 'start',
        'note': f'Auto-recover runtime for {TARGET_SYSTEM}',
        'payload': {},
        'directExecute': True,
    }
    data = json.dumps(payload).encode('utf-8')
    req = urllib.request.Request(API_URL, data=data, method='POST')
    req.add_header('Content-Type', 'application/json')
    req.add_header('Authorization', f'Bearer {API_TOKEN}')
    with urllib.request.urlopen(req, timeout=30) as resp:
        raw = resp.read().decode('utf-8', errors='replace')
        print(raw)
else:
    print('No missing runtime clients. Nothing to start.')

print('\n=== STEP 3: ensure vitrine flags enabled for these profiles ===')
for pid in profile_ids:
    c.execute(
        '''INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
           VALUES (?, ?, 1.0, 1, 'admin_recover', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
           ON CONFLICT(profile_id, system_name)
           DO UPDATE SET is_enabled = 1, updated_at = CURRENT_TIMESTAMP''',
        (pid, TARGET_SYSTEM)
    )
conn.commit()
print(f'Enabled vitrine flags for profile_ids={profile_ids}')

print('\n=== STEP 4: post-check ===')
post = c.execute(
    '''SELECT t.id AS tenant_id, t.slug, ap.requested_enabled, ap.actual_enabled
       FROM tenants t
       JOIN algofund_profiles ap ON ap.tenant_id = t.id
       WHERE lower(t.slug) IN ({})
       ORDER BY t.id'''.format(','.join(['?'] * len(TARGET_SLUGS))),
    tuple(TARGET_SLUGS)
).fetchall()
for r in post:
    print(f"tenant={r['tenant_id']} slug={r['slug']} requested={r['requested_enabled']} actual={r['actual_enabled']}")

vitrine_rows = c.execute(
    '''SELECT COUNT(*) AS cnt
       FROM algofund_active_systems
       WHERE system_name = ? AND COALESCE(is_enabled,1)=1''',
    (TARGET_SYSTEM,)
).fetchone()['cnt']
print(f'vitrine_enabled_rows={vitrine_rows}')

conn.close()
print('DONE')

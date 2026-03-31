#!/usr/bin/env python3
import sqlite3

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
TARGET_SLUGS = ['mehmet-bingx', 'btdd-d1', 'ruslan', 'ali', 'mustafa']

conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
c = conn.cursor()

q = '''SELECT t.id AS tenant_id, t.slug, ap.execution_api_key_name,
              ts.id AS runtime_system_id, ts.name AS runtime_system_name, ts.is_active,
              (SELECT COUNT(*) FROM trading_system_members m WHERE m.system_id = ts.id AND COALESCE(m.is_enabled,1)=1) AS members_count
       FROM tenants t
       JOIN algofund_profiles ap ON ap.tenant_id = t.id
       LEFT JOIN api_keys ak ON ak.name = ap.execution_api_key_name
       LEFT JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = ('ALGOFUND::' || t.slug)
       WHERE lower(t.slug) IN ({})
       ORDER BY t.id'''.format(','.join(['?'] * len(TARGET_SLUGS)))

rows = c.execute(q, tuple(TARGET_SLUGS)).fetchall()
for r in rows:
    print(f"tenant={r['tenant_id']} slug={r['slug']} api={r['execution_api_key_name']} runtime_id={r['runtime_system_id']} runtime_active={r['is_active']} members={r['members_count']}")

conn.close()

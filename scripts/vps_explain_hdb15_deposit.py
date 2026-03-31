#!/usr/bin/env python3
import json
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
SLUG = 'ruslan'
API_KEY = 'HDB_15'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

plan = c.execute(
    '''SELECT t.id AS tenant_id,
              t.slug,
              p.code AS plan_code,
              p.max_deposit_total,
              p.risk_cap_max,
              ap.risk_multiplier,
              ap.execution_api_key_name
       FROM tenants t
       JOIN subscriptions s ON s.tenant_id = t.id AND s.status = 'active'
       JOIN plans p ON p.id = s.plan_id
       JOIN algofund_profiles ap ON ap.tenant_id = t.id
       WHERE t.slug = ?
       LIMIT 1''',
    (SLUG,)
).fetchone()

agg = c.execute(
    '''SELECT COUNT(*) AS strategies,
              MIN(s.max_deposit) AS min_dep,
              MAX(s.max_deposit) AS max_dep,
              AVG(s.max_deposit) AS avg_dep,
              MIN(s.lot_long_percent) AS min_lot,
              MAX(s.lot_long_percent) AS max_lot
       FROM strategies s
       JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE ak.name = ?
         AND s.name LIKE ?
         AND COALESCE(s.is_active, 0) = 1''',
    (API_KEY, 'SAAS::ruslan::%')
).fetchone()

sample = c.execute(
    '''SELECT s.id, s.name, s.max_deposit, s.leverage, s.lot_long_percent, s.lot_short_percent
       FROM strategies s
       JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE ak.name = ?
         AND s.name LIKE ?
         AND COALESCE(s.is_active, 0) = 1
       ORDER BY s.id DESC
       LIMIT 5''',
    (API_KEY, 'SAAS::ruslan::%')
).fetchall()

out = {
    'plan': dict(plan) if plan else None,
    'runtimeAgg': dict(agg) if agg else None,
    'runtimeSample': [dict(r) for r in sample],
}
print(json.dumps(out, ensure_ascii=False, indent=2))
conn.close()

#!/usr/bin/env python3
import json
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
SLUGS = ['mehmet-bingx', 'btdd-d1', 'ruslan', 'ali', 'mustafa']

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

rows = c.execute(
    '''SELECT t.slug,
              t.display_name,
              ap.risk_multiplier,
              ap.execution_api_key_name,
              ts.id AS runtime_system_id,
              COUNT(*) AS strategies,
              ROUND(AVG(s.max_deposit), 2) AS avg_max_deposit,
              MIN(s.max_deposit) AS min_max_deposit,
              MAX(s.max_deposit) AS max_max_deposit,
              ROUND(AVG(s.lot_long_percent), 2) AS avg_lot_long,
              ROUND(AVG(s.lot_short_percent), 2) AS avg_lot_short
       FROM tenants t
       JOIN algofund_profiles ap ON ap.tenant_id = t.id
       JOIN api_keys ak ON ak.name = ap.execution_api_key_name
       JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = ('ALGOFUND::' || t.slug)
       JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled,1)=1
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE lower(t.slug) IN ({})
       GROUP BY t.slug, t.display_name, ap.risk_multiplier, ap.execution_api_key_name, ts.id
       ORDER BY t.slug'''.format(','.join('?' for _ in SLUGS)),
    tuple(SLUGS)
).fetchall()

print(json.dumps([dict(r) for r in rows], ensure_ascii=False, indent=2))
conn.close()

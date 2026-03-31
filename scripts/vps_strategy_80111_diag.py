#!/usr/bin/env python3
import json
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
SID = 80111

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

row = c.execute(
    '''SELECT s.id, s.name, s.market_mode, s.base_symbol, s.quote_symbol,
              s.base_coef, s.quote_coef, s.max_deposit, s.lot_long_percent,
              s.lot_short_percent, s.leverage, s.interval, s.is_active,
              ak.name AS api_key_name
       FROM strategies s
       JOIN api_keys ak ON ak.id = s.api_key_id
       WHERE s.id = ?''',
    (SID,)
).fetchone()

print(json.dumps(dict(row) if row else {}, ensure_ascii=False, indent=2))
conn.close()

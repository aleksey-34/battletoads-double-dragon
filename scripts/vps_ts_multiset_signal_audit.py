#!/usr/bin/env python3
import json
import sqlite3

DB = '/opt/battletoads-double-dragon/backend/database.db'
SYSTEM_NAME = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
c = conn.cursor()

system = c.execute(
    "SELECT id, name FROM trading_systems WHERE name = ? LIMIT 1",
    (SYSTEM_NAME,),
).fetchone()

out = {
    'system': dict(system) if system else None,
    'members': [],
    'runtimeEventTypes7d': [],
    'liveTradeEvents7d': {},
}

if system:
    members = c.execute(
        '''SELECT tsm.strategy_id, COALESCE(tsm.is_enabled,1) AS is_enabled,
                  s.name AS strategy_name, s.base_symbol, s.quote_symbol,
                  s.last_signal, s.last_action, s.updated_at,
                  s.max_deposit, s.lot_long_percent, s.lot_short_percent
           FROM trading_system_members tsm
           JOIN strategies s ON s.id = tsm.strategy_id
           WHERE tsm.system_id = ?
           ORDER BY tsm.id''',
        (int(system['id']),),
    ).fetchall()

    out['members'] = [dict(r) for r in members]

    out['runtimeEventTypes7d'] = [dict(r) for r in c.execute(
        '''WITH members AS (
             SELECT strategy_id
             FROM trading_system_members
             WHERE system_id = ? AND COALESCE(is_enabled,1)=1
           )
           SELECT event_type, COUNT(*) AS cnt, MAX(created_at) AS last_created_at
           FROM strategy_runtime_events e
           JOIN members m ON m.strategy_id = e.strategy_id
           WHERE e.created_at >= (strftime('%s','now','-7 days')*1000)
           GROUP BY event_type
           ORDER BY cnt DESC''',
        (int(system['id']),),
    ).fetchall()]

    live = c.execute(
        '''WITH members AS (
             SELECT strategy_id
             FROM trading_system_members
             WHERE system_id = ? AND COALESCE(is_enabled,1)=1
           )
           SELECT
             COUNT(*) AS events,
             SUM(CASE WHEN lower(COALESCE(trade_type,''))='entry' THEN 1 ELSE 0 END) AS entries,
             SUM(CASE WHEN lower(COALESCE(trade_type,''))='exit' THEN 1 ELSE 0 END) AS exits,
             SUM(CASE WHEN COALESCE(source_order_id,'')<>'' THEN 1 ELSE 0 END) AS with_order_id,
             MAX(actual_time) AS latest_actual_time
           FROM live_trade_events lte
           JOIN members m ON m.strategy_id = lte.strategy_id
           WHERE lte.actual_time >= (strftime('%s','now','-7 days')*1000)''',
        (int(system['id']),),
    ).fetchone()
    out['liveTradeEvents7d'] = dict(live) if live else {}

print(json.dumps(out, ensure_ascii=False, indent=2))
conn.close()

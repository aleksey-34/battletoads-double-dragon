import sqlite3
from datetime import datetime, timezone

DB = '/opt/battletoads-double-dragon/backend/database.db'
SINCE_MS = 1775001600000  # 2026-04-01 00:00:00 UTC
TARGET_KEYS = ('BTDD_D1', 'Mehmet_Bingx', 'HDB_15', 'HDB_18', 'mustafa')
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'

conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row
cur = conn.cursor()

print('=== CONNECTED CLIENTS ===')
for row in cur.execute(
    """
    SELECT t.display_name, p.assigned_api_key_name, p.execution_api_key_name, p.published_system_name, p.actual_enabled, p.updated_at
    FROM algofund_profiles p
    LEFT JOIN tenants t ON t.id = p.tenant_id
    WHERE p.published_system_name = ?
    ORDER BY t.display_name COLLATE NOCASE
    """,
    (TARGET_SYSTEM,),
):
    print(f"{row['display_name']} | assigned={row['assigned_api_key_name']} | exec={row['execution_api_key_name']} | enabled={row['actual_enabled']} | updated_at={row['updated_at']}")

print('\n=== EVENT COUNTS SINCE MIDNIGHT UTC ===')
q = f"""
SELECT api_key_name, event_type, COUNT(*) AS cnt
FROM strategy_runtime_events
WHERE created_at >= ?
  AND api_key_name IN ({','.join('?' for _ in TARGET_KEYS)})
GROUP BY api_key_name, event_type
ORDER BY api_key_name, cnt DESC, event_type
"""
for row in cur.execute(q, (SINCE_MS, *TARGET_KEYS)):
    print(f"{row['api_key_name']} | {row['event_type']} | {row['cnt']}")

print('\n=== LAST 3 EVENTS PER CONNECTED KEY ===')
for api_key in TARGET_KEYS:
    print(f'-- {api_key} --')
    rows = list(cur.execute(
        """
        SELECT event_type, message, created_at
        FROM strategy_runtime_events
        WHERE api_key_name = ? AND created_at >= ?
        ORDER BY created_at DESC
        LIMIT 3
        """,
        (api_key, SINCE_MS),
    ))
    if not rows:
        print('no events')
        continue
    for row in rows:
        ts = datetime.fromtimestamp(row['created_at'] / 1000, tz=timezone.utc).strftime('%Y-%m-%d %H:%M:%S UTC')
        msg = (row['message'] or '').replace('\n', ' ')[:180]
        print(f"{ts} | {row['event_type']} | {msg}")

print('\n=== LIVE TRADE EVENTS FOR ACTIVE SYSTEM MEMBERS SINCE MIDNIGHT UTC ===')
rows = list(cur.execute(
    """
    SELECT COUNT(*) AS cnt, MIN(created_at) AS min_ts, MAX(created_at) AS max_ts
    FROM live_trade_events
    WHERE strategy_id IN (
      SELECT strategy_id FROM trading_system_members m
      JOIN trading_systems s ON s.id = m.system_id
      WHERE s.name = ?
    )
      AND created_at >= ?
    """,
    (TARGET_SYSTEM, SINCE_MS),
))
row = rows[0]
print(f"count={row['cnt']} | first_ts={row['min_ts']} | last_ts={row['max_ts']}")

print('\n=== LATEST MONITORING SNAPSHOTS ===')
for row in cur.execute(
    """
    SELECT a.name, ROUND(m.equity_usd, 2) AS equity_usd, ROUND(m.margin_load_percent, 2) AS margin_load_percent,
           ROUND(m.drawdown_percent, 2) AS drawdown_percent, m.recorded_at
    FROM monitoring_snapshots m
    JOIN api_keys a ON a.id = m.api_key_id
    WHERE a.name IN ({})
      AND m.id IN (SELECT MAX(id) FROM monitoring_snapshots GROUP BY api_key_id)
    ORDER BY a.name COLLATE NOCASE
    """.format(','.join('?' for _ in TARGET_KEYS)),
    TARGET_KEYS,
):
    print(f"{row['name']} | equity={row['equity_usd']} | ML={row['margin_load_percent']}% | DD={row['drawdown_percent']}% | recorded_at={row['recorded_at']}")

conn.close()

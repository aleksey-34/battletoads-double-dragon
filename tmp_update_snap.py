import sqlite3, json

conn = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
with open('/tmp/cleaned_snapshots.json') as f:
    cleaned = f.read()
conn.execute('UPDATE app_runtime_flags SET value = ? WHERE key = ?', (cleaned, 'offer.store.ts_backtest_snapshots'))
conn.commit()
row = conn.execute("SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'").fetchone()
d = json.loads(row[0])
for k in d:
    print(k, ':', 'ret=', d[k].get('ret'), 'trades=', d[k].get('trades'))
conn.close()
print('OK')

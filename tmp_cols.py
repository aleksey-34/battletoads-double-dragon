import sqlite3
c = sqlite3.connect('/opt/battletoads-double-dragon/backend/database.db')
cols = [r[1] for r in c.execute('PRAGMA table_info(api_keys)').fetchall()]
print(cols)
row = c.execute("SELECT * FROM api_keys WHERE name='BTDD_D1'").fetchone()
print(row)
c.close()

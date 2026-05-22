#!/usr/bin/env python3
import sqlite3,json,os
DB=os.path.join(os.path.dirname(os.path.abspath(__file__)),"..","backend","database.db")
conn=sqlite3.connect(DB)
conn.row_factory=sqlite3.Row
cur=conn.cursor()
def show(rows,cols=None):
 for r in rows:
  d=dict(r)
  if cols: print("  "+" | ".join(str(d.get(c)) for c in cols))
  else: print("  "+json.dumps(d,default=str))
def b(msg):
 print("
"+"="*60+"
  "+msg+"
"+"="*60)
b("1.ARTHUR_KEYS")
rows=cur.execute("SELECT id,name,exchange,active FROM api_keys WHERE name LIKE "%artur%"").fetchall()
show(rows,["id","name","exchange","active"])
for k in rows:
 ts=cur.execute("SELECT id,name,is_active,max_open_positions,market_type FROM trading_systems WHERE api_key_id=?",(k["id"],)).fetchall()
 for t in ts:
  m=cur.execute("SELECT tm.strategy_id,s.strategy_type,s.base_symbol,tm.weight,tm.is_enabled FROM trading_system_members tm JOIN strategies s ON s.id=tm.strategy_id WHERE tm.system_id=?",(t["id"],)).fetchall()
  print(f" TS {t[chr(39)+chr(105)+chr(100)+chr(39)]} {t[chr(39)+chr(110)+chr(97)+chr(109)+chr(101)+chr(39)]} OP={t[chr(39)+chr(109)+chr(97)+chr(120)+chr(95)+chr(111)+chr(112)+chr(101)+chr(110)+chr(95)+chr(112)+chr(111)+chr(115)+chr(105)+chr(116)+chr(105)+chr(111)+chr(110)+chr(115)+chr(39)]}")
  for x in m: print(f"  mem sid={x[chr(39)+chr(115)+chr(116)+chr(114)+chr(97)+chr(116)+chr(101)+chr(103)+chr(121)+chr(95)+chr(105)+chr(100)+chr(39)]} {x[chr(39)+chr(115)+chr(116)+chr(114)+chr(97)+chr(116)+chr(101)+chr(103)+chr(121)+chr(95)+chr(116)+chr(121)+chr(112)+chr(101)+chr(39)]} {x[chr(39)+chr(98)+chr(97)+chr(115)+chr(101)+chr(95)+chr(115)+chr(121)+chr(109)+chr(98)+chr(111)+chr(108)+chr(39)]}")
b("2.CLIENT_5374535192")
show(cur.execute("SELECT * FROM algofund_profiles WHERE telegram_id LIKE "%5374535192%"").fetchall())
b("3.DCA")
show(cur.execute("SELECT id,name,base_symbol,dca_base_amount_usdt,dca_step_percent,dca_max_orders,is_active FROM strategies WHERE strategy_type="dca"").fetchall(),["id","name","base_symbol","dca_base_amount_usdt","dca_step_percent","dca_max_orders","is_active"])
b("4.SNAPSHOTS")
show(cur.execute("SELECT id,snapshot_key,created_at FROM ts_backtest_snapshots ORDER BY id DESC LIMIT 10").fetchall(),["id","snapshot_key","created_at"])
b("5.MISMATCHES")
show(cur.execute("SELECT s.id,s.name,s.is_active,s.auto_update,s.strategy_type FROM strategies s JOIN api_keys a ON a.id=s.api_key_id WHERE s.is_active!=s.auto_update LIMIT 10").fetchall(),["id","name","is_active","auto_update","strategy_type"])
conn.close()
print("
Done.")

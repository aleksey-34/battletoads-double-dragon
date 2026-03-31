set -e
BASE=http://127.0.0.1:3001
AUTH='Authorization: Bearer SuperSecure2026Admin!'
for k in BTDD_D1 HDB_15 HDB_18 Mehmet_Bingx mustafa; do
  echo "=== $k positions ==="
  curl -s -H "$AUTH" "$BASE/api/positions/$k" > /tmp/pos_$k.json
  python3 - <<PY
import json
with open('/tmp/pos_${k}.json','r',encoding='utf-8') as f:
 d=json.load(f)
rows=d if isinstance(d,list) else []
print('open_positions',len(rows))
print('symbols',[ (r.get('symbol') or r.get('base_symbol') or '') for r in rows][:10])
PY
  echo "=== $k strategies ==="
  curl -s -H "$AUTH" "$BASE/api/strategies/$k" > /tmp/str_$k.json
  python3 - <<PY
import json
with open('/tmp/str_${k}.json','r',encoding='utf-8') as f:
 d=json.load(f)
rows=d if isinstance(d,list) else []
active=[r for r in rows if bool(r.get('is_active'))]
nonflat=[r for r in active if str(r.get('state') or '').lower()!='flat']
print('active',len(active),'nonflat',len(nonflat))
print('nonflat_ids',[r.get('id') for r in nonflat[:12]])
PY
  echo
done

echo '=== live_trade_events latest 40 ==='
sqlite3 -header -column /opt/battletoads-double-dragon/backend/database.db "select id,api_key_name,system_id,strategy_id,trade_type,side,source_symbol,datetime(created_at/1000,'unixepoch') as created_utc from live_trade_events order by id desc limit 40;"
set -e
BASE=http://127.0.0.1:3001
for k in BTDD_D1 HDB_15 HDB_18 Mehmet_Bingx mustafa; do
  echo "=== $k positions ==="
  curl -s "$BASE/api/positions/$k" | python3 - <<'PY'
import sys,json
try:
 d=json.load(sys.stdin)
 rows=d if isinstance(d,list) else []
 print('open_positions',len(rows))
 syms=sorted({str((r.get('symbol') or r.get('base_symbol') or '')).strip() for r in rows if (r.get('symbol') or r.get('base_symbol'))})
 print('symbols',','.join([s for s in syms if s]))
except Exception as e:
 print('parse_error',e)
PY
  echo "=== $k strategies ==="
  curl -s "$BASE/api/strategies/$k" | python3 - <<'PY'
import sys,json
try:
 d=json.load(sys.stdin)
 rows=d if isinstance(d,list) else []
 active=[r for r in rows if int(bool(r.get('is_active')))==1]
 nonflat=[r for r in active if str(r.get('state') or '').lower()!='flat']
 withsig=[r for r in active if str(r.get('last_signal') or '').strip()!='']
 witherr=[r for r in active if str(r.get('last_error') or '').strip()!='']
 print('active',len(active),'nonflat',len(nonflat),'with_last_signal',len(withsig),'with_last_error',len(witherr))
 print('sample_nonflat',','.join(str(r.get('id')) for r in nonflat[:8]))
except Exception as e:
 print('parse_error',e)
PY
  echo
 done
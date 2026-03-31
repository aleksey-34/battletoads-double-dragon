import json
import urllib.parse
import urllib.request
import urllib.error

BASE='http://127.0.0.1:3001'
AUTH={'Authorization':'Bearer SuperSecure2026Admin!'}
NAMES=[
    'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v',
    'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh',
    'ALGOFUND_MASTER::BTDD_D1::algofund-master-btdd-d1-ts-multiset-v2-h-h6e6sh',
]

def get(url):
    req=urllib.request.Request(url,headers=AUTH)
    try:
        with urllib.request.urlopen(req,timeout=30) as r:
            return json.loads(r.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        body=e.read().decode('utf-8','ignore')
        raise RuntimeError(f"HTTP {e.code}: {body}")

for name in NAMES:
    print('TARGET',name)
    enc=urllib.parse.quote(name,safe='')
    try:
        h=get(f"{BASE}/api/saas/admin/reports/ts-health?systemName={enc}&lookbackHours=720")
        c=get(f"{BASE}/api/saas/admin/reports/closed-positions?systemName={enc}&periodHours=720&limit=300")
    except Exception as e:
        print('ERROR',e)
        print('---')
        continue
    hs=(h.get('systems') or [{}])[0]
    cs=c.get('summary') or {}
    rows=c.get('rows') or []
    print('HEALTH connectedClients=',hs.get('connectedClients'),'members=',hs.get('membersEnabled'),'/',hs.get('membersTotal'),'recent=',hs.get('membersWithRecentEvents'))
    snap=hs.get('latestAccountSnapshot') or {}
    print('ACCOUNT equity=',snap.get('equityUsd'),'dd=',snap.get('drawdownPercent'),'margin=',snap.get('marginLoadPercent'))
    print('CLOSED summary_keys=',sorted(cs.keys()))
    print('CLOSED count=',cs.get('closedCount'),'wins=',cs.get('wins'),'losses=',cs.get('losses'),'pnl_total=',cs.get('totalRealizedPnl'),'win_rate=',cs.get('winRatePercent'))
    if rows:
        r=rows[0]
        print('LAST symbol=',r.get('symbol'),'side=',r.get('side'),'pnl=',r.get('realizedPnl'),'time=',r.get('exitTime'))
    else:
        print('LAST none')
    print('---')

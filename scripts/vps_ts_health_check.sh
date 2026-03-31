#!/usr/bin/env bash
set -euo pipefail
BASE='http://127.0.0.1:3001'
AUTH='Authorization: Bearer SuperSecure2026Admin!'
SUMMARY_JSON=$(mktemp)
trap 'rm -f "$SUMMARY_JSON"' EXIT
curl -s -H "$AUTH" "$BASE/api/saas/admin/summary" > "$SUMMARY_JSON"
python3 - <<'PY' "$SUMMARY_JSON"
import json,sys,subprocess,urllib.parse
path=sys.argv[1]
d=json.load(open(path,'r',encoding='utf-8'))
systems=sorted(set([str(x) for x in (d.get('publishedAlgofundSystems') or []) if x]))
print('PUBLISHED_SYSTEMS',len(systems))
for s in systems:
    print('SYSTEM',s)
print('---')
targets=[s for s in systems if 'ts-multiset-v2-h6e6sh' in s or 'high-trade-curated-pu213v' in s]
for s in targets:
    enc=urllib.parse.quote(s,safe='')
    health_cmd=f"curl -s -H \"Authorization: Bearer SuperSecure2026Admin!\" \"http://127.0.0.1:3001/api/saas/admin/reports/ts-health?systemName={enc}&lookbackHours=72\""
    closed_cmd=f"curl -s -H \"Authorization: Bearer SuperSecure2026Admin!\" \"http://127.0.0.1:3001/api/saas/admin/reports/closed-positions?systemName={enc}&periodHours=168&limit=50\""
    health=json.loads(subprocess.check_output(health_cmd,shell=True,text=True) or '{}')
    closed=json.loads(subprocess.check_output(closed_cmd,shell=True,text=True) or '{}')
    rows=closed.get('rows') or []
    summary=closed.get('summary') or {}
    hs=(health.get('systems') or [{}])[0]
    print('TARGET',s)
    print('HEALTH connectedClients',hs.get('connectedClients'),'membersEnabled',hs.get('membersEnabled'),'membersTotal',hs.get('membersTotal'),'membersWithRecentEvents',hs.get('membersWithRecentEvents'))
    print('HEALTH account equity',((hs.get('latestAccountSnapshot') or {}).get('equityUsd')),'dd',((hs.get('latestAccountSnapshot') or {}).get('drawdownPercent')))
    print('CLOSED count',summary.get('closedCount'),'wins',summary.get('wins'),'losses',summary.get('losses'),'pnl',summary.get('realizedPnl'))
    print('CLOSED sample',len(rows))
    if rows:
        first=rows[0]
        print('LAST',first.get('symbol'),first.get('side'),first.get('realizedPnl'),first.get('exitTime'))
    print('---')
PY

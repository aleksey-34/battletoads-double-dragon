import json
import urllib.request
base = 'http://127.0.0.1:3001/api/saas/admin'
headers = {'Authorization': 'Bearer SuperSecure2026Admin!'}
for path in ['/summary', '/offer-store']:
    req = urllib.request.Request(base + path, headers=headers)
    with urllib.request.urlopen(req, timeout=20) as r:
        data = json.loads(r.read().decode())
    print('===', path, '===')
    print(json.dumps(data, ensure_ascii=False)[:12000])

import json
import urllib.request
base = 'http://127.0.0.1:3001/api/saas/admin'
headers = {'Authorization': 'Bearer SuperSecure2026Admin!'}
summary = json.loads(urllib.request.urlopen(urllib.request.Request(base + '/summary', headers=headers), timeout=20).read().decode())
store = json.loads(urllib.request.urlopen(urllib.request.Request(base + '/offer-store', headers=headers), timeout=20).read().decode())
print('publishedOfferIds', len(store.get('publishedOfferIds') or []))
print('offers', len(store.get('offers') or []))
algofund = summary.get('algofund') or {}
print('algofundKeys', list(algofund.keys()))
for key in ['storefrontSystems','activeSystems','systems','offers','clients','profiles','tenantAssignments','copytradingTenant']:
    value = algofund.get(key)
    if isinstance(value, list):
        print(key, 'list', len(value))
        for item in value[:10]:
            print(json.dumps(item, ensure_ascii=False)[:800])
    elif isinstance(value, dict):
        print(key, 'dict', list(value.keys())[:20])
        print(json.dumps(value, ensure_ascii=False)[:1200])
    elif value is not None:
        print(key, type(value).__name__, str(value)[:1200])
print('topSummaryKeys', list(summary.keys()))

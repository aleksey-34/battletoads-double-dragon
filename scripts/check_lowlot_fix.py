#!/usr/bin/env python3
"""Quick check of low-lot recommendations after leverage fix deploy."""
import subprocess
import json

result = subprocess.run(
    ['curl', '-s', 'http://127.0.0.1:3001/api/saas/admin/low-lot-recommendations',
     '-H', 'Authorization: Bearer SuperSecure2026Admin!'],
    capture_output=True, text=True
)

try:
    d = json.loads(result.stdout)
except Exception as e:
    print("JSON parse error:", e)
    print("Raw:", result.stdout[:500])
    exit(1)

items = d.get('items', [])
print(f"Total low-lot items: {len(items)}")
for i in items[:20]:
    pair = i.get('pair', '?')
    dep = i.get('maxDeposit', 0)
    lot = i.get('lotPercent', 0)
    lev = i.get('leverage', 1)
    sug = i.get('suggestedDepositMin', 0)
    err = str(i.get('lastError', ''))[:80]
    tenants = [t.get('slug', '?') for t in i.get('tenants', [])]
    print(f"  {pair} | dep={dep} lot={lot}% lev={lev}x sugMin={sug} | tenants={tenants}")
    if err:
        print(f"    err: {err}")

if not items:
    print("No low-lot items — fix is working!")

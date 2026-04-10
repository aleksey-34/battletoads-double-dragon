#!/bin/bash
# Check what algofund storefront now returns
curl -s 'https://battletoads.top/api/client/algofund/state' \
  -H 'Cookie: btdd_session=test' \
  -b 'btdd_session=test' 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    systems = data.get('availableSystems', [])
    print(f'Available systems: {len(systems)}')
    for s in systems:
        name = s.get('name', '?')
        snap = s.get('backtestSnapshot') or {}
        if snap:
            print(f'  {name}: ret={snap.get(\"ret\")}, dd={snap.get(\"dd\")}, pf={snap.get(\"pf\")}, trades={snap.get(\"trades\")}')
        else:
            print(f'  {name}: NO SNAPSHOT')
except Exception as e:
    print(f'Parse error: {e}')
    raw = sys.stdin.read()[:200]
    print(raw)
" || echo "curl failed"

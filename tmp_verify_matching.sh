#!/bin/bash
# Direct DB check: simulate what getAlgofundState does after the fix
# 1. List all ALGOFUND_MASTER systems
# 2. For each, try to match a snapshot key
# 3. Show result

echo "=== All ALGOFUND_MASTER systems ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT name FROM trading_systems WHERE name LIKE 'ALGOFUND_MASTER%' ORDER BY name"

echo ""
echo "=== Snapshot keys in DB ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'" | python3 -c "
import sys, json
d = json.load(sys.stdin)
snapshot_keys = list(d.keys())
print('Snapshot keys:', snapshot_keys)
print()

# Simulate matching logic for each system
systems = [
    'ALGOFUND_MASTER::BTDD_D1',
    'ALGOFUND_MASTER::BTDD_D1::btdd-d1-ts-multiset-v2-spd-h6e6sh',
    'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v',
    'ALGOFUND_MASTER::BTDD_D1::high-trade-curated-r0pf9x',
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-balanced-7-v1',
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-mono-3markets-v1',
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-synth-5pairs-v1',
    'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh',
]

for sname in systems:
    # Exact
    match = d.get(sname)
    if match:
        print(f'{sname} -> EXACT match, ret={match[\"ret\"]}')
        continue
    # CI exact
    sname_lower = sname.lower()
    ci = None
    for k in snapshot_keys:
        if k.lower() == sname_lower:
            ci = d[k]
            break
    if ci:
        print(f'{sname} -> CI exact match, ret={ci[\"ret\"]}')
        continue
    # Short name
    parts = sname.split('::')
    parts = [p for p in parts if p]
    is_parent = len(parts) <= 2
    short = parts[-1] if len(parts) >= 3 else (parts[1] if len(parts) == 2 else '')
    if is_parent:
        print(f'{sname} -> PARENT system, skip fuzzy -> NO SNAPSHOT')
        continue
    # Try short name match
    found = False
    for k in snapshot_keys:
        if k.lower() == short.lower() or k.lower().endswith('::' + short.lower()):
            print(f'{sname} -> short match key={k}, ret={d[k][\"ret\"]}')
            found = True
            break
    if found:
        continue
    # Fuzzy
    import re
    stripped = re.sub(r'^(algofund-master-|btdd-d1-|btdd_d1-)+', '', short.lower())
    if len(stripped) >= 5:
        for k in snapshot_keys:
            kstripped = re.sub(r'^(algofund-master-|btdd-d1-|btdd_d1-)+', '', k.split('::')[-1].lower() if '::' in k else k.lower())
            if kstripped == stripped or kstripped.startswith(stripped[:15]) or stripped.startswith(kstripped[:15]):
                print(f'{sname} -> fuzzy match key={k}, ret={d[k][\"ret\"]}')
                found = True
                break
    if not found:
        print(f'{sname} -> NO SNAPSHOT')
"

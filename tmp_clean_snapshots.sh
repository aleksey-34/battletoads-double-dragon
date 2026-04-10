#!/bin/bash
# Clean stale/miskeyed snapshots from ts_backtest_snapshots.
# Keep only properly-keyed ALGOFUND_MASTER:: snapshots. Remove stale ones with wrong keys.
cd /opt/battletoads-double-dragon/backend

echo "=== BEFORE: snapshot keys ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'" | python3 -c "
import sys, json
d = json.load(sys.stdin)
print(f'Total keys: {len(d)}')
for k in d:
    print(f'  {k}')

# Remove stale keys: single-colon keys, keys without ALGOFUND_MASTER:: prefix
stale = []
for k in list(d.keys()):
    # Keep only keys with ALGOFUND_MASTER:: prefix
    if not k.startswith('ALGOFUND_MASTER::'):
        stale.append(k)

print(f'\nStale keys to remove: {len(stale)}')
for k in stale:
    print(f'  REMOVING: {k}')
    del d[k]

print(f'\nRemaining keys: {len(d)}')
for k in d:
    print(f'  {k}: ret={d[k].get(\"ret\")}, trades={d[k].get(\"trades\")}')

# Write cleaned data back
cleaned = json.dumps(d)
print(f'\nCleaned JSON length: {len(cleaned)}')
with open('/tmp/cleaned_snapshots.json', 'w') as f:
    f.write(cleaned)
"

echo ""
echo "=== Updating DB ==="
CLEANED=$(cat /tmp/cleaned_snapshots.json)
sqlite3 database.db "UPDATE app_runtime_flags SET value = '$(echo "$CLEANED" | sed "s/'/''/"g")' WHERE key = 'offer.store.ts_backtest_snapshots'"
echo "Done. Verifying..."

echo ""
echo "=== AFTER: snapshot keys ==="
sqlite3 database.db "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'" | python3 -c "
import sys, json
d = json.load(sys.stdin)
for k in d:
    print(f'  {k}: ret={d[k].get(\"ret\")}, trades={d[k].get(\"trades\")}')
"

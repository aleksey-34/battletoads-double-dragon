#!/bin/bash
echo "=== TENANT ==="
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id, slug, product_mode FROM tenants WHERE product_mode='synctrade_client'"
echo "=== PROFILE ==="
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT * FROM synctrade_profiles"
echo "=== API TEST ==="
# Get tenant ID dynamically
TID=$(sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id FROM tenants WHERE product_mode='synctrade_client' LIMIT 1")
echo "Tenant ID: $TID"
if [ -n "$TID" ]; then
  curl -s "http://localhost:3001/api/saas/synctrade/$TID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d:
    print('ERROR:', d['error'])
else:
    p = d.get('profile', {})
    print('Profile ID:', p.get('id'))
    print('Hedge accounts:', p.get('hedge_accounts_json', p.get('hedgeAccounts')))
    print('Enabled:', p.get('enabled'))
"
fi

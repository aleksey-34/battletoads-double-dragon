#!/bin/bash
curl -s http://localhost:3001/api/saas/admin/summary | python3 -c "
import sys, json
d = json.load(sys.stdin)
for t in d.get('tenants', []):
    tenant = t.get('tenant', {})
    print(tenant.get('id'), tenant.get('slug'), tenant.get('product_mode'))
"
echo "---"
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id, tenant_id, hedge_accounts_json FROM synctrade_profiles"

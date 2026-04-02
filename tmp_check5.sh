#!/bin/bash
# Test PATCH with hedge account
curl -s -X PATCH "http://localhost:3001/api/saas/synctrade/47949" \
  -H "Content-Type: application/json" \
  -d '{"hedgeAccounts":[{"displayName":"Test1","apiKeyName":"leventyilmaz07fb","maxSpendUsdt":45,"targetLossUsdt":45}],"enabled":true,"targetMode":"usdt","targetValue":45}' | python3 -c "
import sys, json
d = json.load(sys.stdin)
if 'error' in d:
    print('ERROR:', d['error'])
else:
    p = d.get('profile', {})
    print('Hedge accounts:', p.get('hedgeAccounts'))
    print('Enabled:', p.get('enabled'))
    print('target_mode:', p.get('target_mode'))
    print('target_value:', p.get('target_value'))
"
echo ""
echo "=== DB CHECK ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT hedge_accounts_json, enabled, target_mode, target_value FROM synctrade_profiles WHERE tenant_id=47949"

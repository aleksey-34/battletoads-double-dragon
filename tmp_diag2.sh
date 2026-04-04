#!/bin/bash
cd /opt/battletoads-double-dragon

# Create fresh magic link
TOKEN_RAW="diag_$(date +%s)"
node -e "
const db = require('better-sqlite3')('./backend/database.db');
db.prepare(\"DELETE FROM client_magic_links WHERE tenant_id=41003\").run();
db.prepare(\"INSERT INTO client_magic_links(tenant_id,token,expires_at) VALUES(41003,?,datetime('now','+1 hour'))\").run('$TOKEN_RAW');
console.log('created link: $TOKEN_RAW');
"

# Login via magic link
LOGIN_RESP=$(curl -s -X POST http://localhost:3001/api/auth/client/magic-login -H 'Content-Type: application/json' -d "{\"token\":\"$TOKEN_RAW\"}")
echo "LOGIN: $LOGIN_RESP" | head -c 200

BEARER=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
if [ -z "$BEARER" ]; then
  echo "No bearer token, trying GET..."
  LOGIN_RESP=$(curl -s "http://localhost:3001/api/auth/client/magic-login/$TOKEN_RAW")
  echo "LOGIN2: $LOGIN_RESP" | head -c 200
  BEARER=$(echo "$LOGIN_RESP" | python3 -c "import sys,json; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
fi

if [ -z "$BEARER" ]; then
  echo "FAILED to get bearer"
  exit 1
fi

echo ""
echo "BEARER OK: ${BEARER:0:20}..."

# Get algofund state
curl -s -H "Authorization: Bearer $BEARER" http://localhost:3001/api/client/algofund/state | python3 -c "
import sys, json
d = json.load(sys.stdin)
state = d.get('state', d)
prof = state.get('profile', {})
print('published_system_name:', repr(prof.get('published_system_name', '')))
print('actual_enabled:', prof.get('actual_enabled'))

systems = state.get('availableSystems', [])
print(f'\nSYSTEMS ({len(systems)}):')
for s in systems:
    snap = s.get('backtestSnapshot')
    eq_pts = len(snap.get('equityPoints', [])) if snap else 0
    print(f'  name={s[\"name\"]}')
    print(f'    active={s[\"isActive\"]}  members={s[\"memberCount\"]}  snap={eq_pts}pts ret={snap.get(\"ret\") if snap else \"NONE\"}')
"

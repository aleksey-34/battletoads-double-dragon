#!/bin/bash
# Check algofund state for tenant 41003
cd /opt/battletoads-double-dragon

# Get magic link
LINK=$(node -e "
const db = require('better-sqlite3')('./backend/database.db');
const row = db.prepare(\"SELECT token FROM client_magic_links WHERE tenant_id=41003 ORDER BY id DESC LIMIT 1\").get();
if(row) console.log(row.token);
" 2>/dev/null)

if [ -z "$LINK" ]; then
  echo "No magic link found, creating one..."
  LINK="diag_token_$(date +%s)"
  node -e "
  const db = require('better-sqlite3')('./backend/database.db');
  db.prepare(\"INSERT INTO client_magic_links(tenant_id,token,expires_at) VALUES(41003,?,(datetime('now','+1 hour')))\").run('$LINK');
  " 2>/dev/null
fi

# Login
TOKEN=$(curl -s http://localhost:3001/api/auth/client/magic-login/$LINK | python3 -c "import sys,json; d=json.load(sys.stdin); print(d.get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Login failed"
  exit 1
fi

# Get algofund state
echo "=== PROFILE ==="
curl -s -H "Authorization: Bearer $TOKEN" http://localhost:3001/api/client/algofund/state | python3 -c "
import sys, json
d = json.load(sys.stdin)
state = d.get('state', d)
prof = state.get('profile', {})
print('published_system_name:', repr(prof.get('published_system_name', '')))
print('actual_enabled:', prof.get('actual_enabled'))

systems = state.get('availableSystems', [])
print(f'\n=== SYSTEMS ({len(systems)}) ===')
for s in systems:
    snap = s.get('backtestSnapshot')
    eq_pts = len(snap.get('equityPoints', [])) if snap else 0
    print(f\"  {s['name']}  active={s['isActive']}  snap_eq_pts={eq_pts}  snap_ret={snap.get('ret') if snap else 'NONE'}\")
" 2>/dev/null

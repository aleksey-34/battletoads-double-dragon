#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# 001_diagnose_all.sh — Full system diagnostic
# Run: bash scripts/001_diagnose_all.sh
# Requires: curl, jq (if available)
# ═══════════════════════════════════════════════════════════════════════
set -euo pipefail

API="${API_BASE:-http://localhost:3001}"
AUTH="${BTDD_AUTH:-}"
CURL="curl -s -H 'Content-Type: application/json'"
if [ -n "$AUTH" ]; then
  CURL="$CURL -H 'Authorization: Bearer $AUTH'"
fi

banner() {
  echo ""
  echo "══════════════════════════════════════════════════════════════"
  echo "  $1"
  echo "══════════════════════════════════════════════════════════════"
}

# ── 0. Health ──────────────────────────────────────────────────────────
banner "0. Health Check"
eval "$CURL $API/api/healthz"
echo ""

# ── 1. All tenants ────────────────────────────────────────────────────
banner "1. All Tenants"
TENANTS=$(eval "$CURL $API/api/saas/admin/tenants")
echo "$TENANTS" | python3 -c "
import sys, json
tenants = json.load(sys.stdin)
if not isinstance(tenants, list):
    print('FAILED:', tenants)
    sys.exit(0)
for t in tenants:
    tid = t.get('id')
    slug = t.get('slug','-')
    name = t.get('display_name','-')
    tgid = t.get('telegram_id','-')
    status = t.get('status','-')
    key = t.get('assigned_api_key_name','-')
    print(f'  id={tid} slug={slug} name={name} tg={tgid} status={status} key={key}')
print(f'Total: {len(tenants)} tenants')
"

# ── 2. Zombie Scan ────────────────────────────────────────────────────
banner "2. Zombie Strategy Scan (all tenants)"
echo "$TENANTS" | python3 -c "
import sys, json, urllib.request

tenants = json.load(sys.stdin)
if not isinstance(tenants, list):
    print('FAILED')
    sys.exit(1)

zombie_tenants = 0
for t in tenants:
    tid = t.get('id')
    slug = t.get('slug','-')
    name = t.get('display_name','-')
    
    # Get profile
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/saas/algofund/{tid}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            profile = json.loads(resp.read())
    except Exception as e:
        print(f'  SKIP {name}: profile error {e}')
        continue
    
    exec_key = profile.get('executionApiKeyName') or profile.get('assignedApiKeyName')
    if not exec_key:
        continue
    
    client_name = f'ALGOFUND::{slug}'
    
    # Get TS
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/trading-systems/{exec_key}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            tss = json.loads(resp.read())
    except:
        continue
    
    if not isinstance(tss, list):
        continue
    
    found_ts = next((ts for ts in tss if ts.get('name') == client_name), None)
    if not found_ts:
        print(f'  ⚠ {name}: TS \"{client_name}\" NOT FOUND on key {exec_key}')
        continue
    
    # Get strategies
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/strategies/{exec_key}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            strategies = json.loads(resp.read())
    except:
        continue
    
    if not isinstance(strategies, list):
        continue
    
    active = [s for s in strategies if s.get('is_active') and not s.get('is_archived')]
    ts_member_ids = {m.get('strategy_id') for m in found_ts.get('members', [])}
    zombies = [s for s in active if s.get('id') not in ts_member_ids]
    
    if zombies:
        zombie_tenants += 1
        print(f'  ⚠ ZOMBIE {name} (key={exec_key}): {len(zombies)} strategies active but NOT in TS!')
        for z in zombies:
            print(f'      id={z.get(\"id\")} {z.get(\"name\")} ({z.get(\"base_symbol\")}/{z.get(\"quote_symbol\")})')
        # Show TS members for comparison
        print(f'      TS members ({len(found_ts.get(\"members\",[]))}): {[m.get(\"strategy_id\") for m in found_ts.get(\"members\",[])][:10]}...')
    else:
        print(f'  ✓ {name}: clean ({len(active)} active, {len(found_ts.get(\"members\",[]))} in TS)')

print(f'Total tenants with zombies: {zombie_tenants}/{len(tenants)}')
"

# ── 3. Client 5374535192 ───────────────────────────────────────────────
banner "3. Client 5374535192 Full State"
echo "$TENANTS" | python3 -c "
import sys, json, urllib.request

tenants = json.load(sys.stdin)
client = next((t for t in tenants if str(t.get('telegram_id')) == '5374535192'), None)
if not client:
    print('CLIENT 5374535192 NOT FOUND in tenants!')
    sys.exit(1)

tid = client['id']
slug = client['slug']
name = client['display_name']
print(f'Tenant: id={tid} slug={slug} name={name}')
print(f'Telegram: {client.get(\"telegram_username\")} / {client.get(\"telegram_id\")}')
print(f'Status: {client.get(\"status\")}')
print(f'Plan: {client.get(\"plan_name\")}')
print(f'Assigned key: {client.get(\"assigned_api_key_name\")}')

# Profile
try:
    req = urllib.request.Request(f'http://localhost:3001/api/saas/algofund/{tid}')
    req.add_header('Content-Type', 'application/json')
    with urllib.request.urlopen(req, timeout=30) as resp:
        profile = json.loads(resp.read())
    print(f'Profile: riskMul={profile.get(\"riskMultiplier\")} reqEnabled={profile.get(\"requestedEnabled\")} actualEnabled={profile.get(\"actualEnabled\")}')
    print(f'Published system: {profile.get(\"publishedSystemName\")}')
    print(f'Execution key: {profile.get(\"executionApiKeyName\")}')
    exec_key = profile.get('executionApiKeyName') or profile.get('assignedApiKeyName')
except Exception as e:
    print(f'Profile error: {e}')
    sys.exit(1)

if exec_key:
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/trading-systems/{exec_key}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            tss = json.loads(resp.read())
        client_name = f'ALGOFUND::{slug}'
        found_ts = next((ts for ts in tss if ts.get('name') == client_name), None)
        if found_ts:
            print(f'TS: id={found_ts.get(\"id\")} maxOP={found_ts.get(\"max_open_positions\")} members={len(found_ts.get(\"members\",[]))} active={found_ts.get(\"is_active\")}')
            for m in found_ts.get('members', []):
                print(f'  member: sid={m.get(\"strategy_id\")} weight={m.get(\"weight\")} enabled={m.get(\"is_enabled\")} role={m.get(\"member_role\")}')
        else:
            print(f'TS \"{client_name}\" NOT FOUND on key {exec_key}')
            print(f'Available TS: {[ts.get(\"name\") for ts in tss]}')
    except Exception as e:
        print(f'TS error: {e}')
    
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/strategies/{exec_key}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            strategies = json.loads(resp.read())
        active = [s for s in strategies if s.get('is_active') and not s.get('is_archived')]
        ts_member_ids = {m.get('strategy_id') for m in found_ts.get('members', [])} if found_ts else set()
        zombies = [s for s in active if s.get('id') not in ts_member_ids]
        print(f'Active strategies: {len(active)}')
        if zombies:
            print(f'⚠ ZOMBIES: {len(zombies)}')
            for z in zombies:
                print(f'  ZOMBIE: id={z.get(\"id\")} {z.get(\"name\")} ({z.get(\"base_symbol\")}/{z.get(\"quote_symbol\")})')
    except Exception as e:
        print(f'Strategies error: {e}')
"

# ── 4. Backtest Quality ────────────────────────────────────────────────
banner "4. Backtest Quality (first 3 tenants)"
echo "$TENANTS" | python3 -c "
import sys, json, urllib.request

tenants = json.load(sys.stdin)
tested = 0
for t in tenants[:3]:
    tid = t.get('id')
    slug = t.get('slug','-')
    name = t.get('display_name','-')
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/saas/algofund/{tid}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            profile = json.loads(resp.read())
    except:
        continue
    
    exec_key = profile.get('executionApiKeyName') or profile.get('assignedApiKeyName')
    if not exec_key:
        continue
    client_name = f'ALGOFUND::{slug}'
    
    try:
        req = urllib.request.Request(f'http://localhost:3001/api/trading-systems/{exec_key}')
        req.add_header('Content-Type', 'application/json')
        with urllib.request.urlopen(req, timeout=30) as resp:
            tss = json.loads(resp.read())
        found_ts = next((ts for ts in tss if ts.get('name') == client_name), None)
        if not found_ts:
            continue
        ts_id = found_ts.get('id')
    except:
        continue
    
    if not ts_id:
        continue
    
    # Run backtest
    bt_body = json.dumps({
        'dateFrom': '2025-01-01',
        'dateTo': '2026-05-01',
        'initialBalance': 1000,
    }).encode()
    try:
        req = urllib.request.Request(
            f'http://localhost:3001/api/trading-systems/{exec_key}/{ts_id}/backtest',
            data=bt_body,
            headers={'Content-Type': 'application/json'}
        )
        with urllib.request.urlopen(req, timeout=120) as resp:
            bt = json.loads(resp.read())
        summary = bt.get('summary', {})
        print(f'{name}: PnL={summary.get(\"totalReturnPercent\",\"?\")}% PF={summary.get(\"profitFactor\",\"?\")} DD={summary.get(\"maxDrawdownPercent\",\"?\")}% Trades={summary.get(\"totalTrades\",\"?\")}')
        tested += 1
    except Exception as e:
        print(f'{name}: BACKTEST FAILED — {e}')

if tested == 0:
    print('No tenants could be backtested!')
else:
    print(f'Tested {tested} tenants')
"

banner "5. DONE"
echo "Full report above. Send this output to the developer."
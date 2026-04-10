#!/bin/bash
echo "=== 1. ALL LIVE ALGOFUND_MASTER TRADING SYSTEMS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" \
  "SELECT ts.id, ts.name, COUNT(tsm.id) as members FROM trading_systems ts LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id WHERE ts.name LIKE 'ALGOFUND_MASTER%' GROUP BY ts.id ORDER BY ts.name"

echo ""
echo "=== 2. ALGOFUND ACTIVE SYSTEMS TABLE ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" \
  "SELECT id, system_name, is_enabled FROM algofund_active_systems ORDER BY system_name"

echo ""
echo "=== 3. TS BACKTEST SNAPSHOTS KEYS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db \
  "SELECT key FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'" | head -1
sqlite3 /opt/battletoads-double-dragon/backend/database.db \
  "SELECT substr(value, 1, 500) FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'"

echo ""
echo "=== 4. ALGOFUND PROFILES (who connects to what) ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" \
  "SELECT ap.tenant_id, t.display_name, ap.published_system_name, ap.risk_multiplier, ap.requested_enabled, ap.actual_enabled FROM algofund_profiles ap JOIN tenants t ON t.id = ap.tenant_id ORDER BY ap.tenant_id"

echo ""
echo "=== 5. CLIENT ALGOFUND STATE ENDPOINT TEST ==="
curl -s 'http://localhost:3001/api/client/algofund/state' \
  -H 'Cookie: btdd_client_session=test' 2>/dev/null | python3 -c "
import sys, json
try:
    data = json.load(sys.stdin)
    systems = data.get('availableSystems', [])
    print(f'Available systems: {len(systems)}')
    for s in systems:
        name = s.get('name', '?')
        snap = s.get('backtestSnapshot', {}) or {}
        print(f'  {name}: ret={snap.get(\"ret\",\"?\")}, dd={snap.get(\"dd\",\"?\")}, pf={snap.get(\"pf\",\"?\")}, trades={snap.get(\"trades\",\"?\")}, period={snap.get(\"periodDays\",\"?\")}d, finalEq={snap.get(\"finalEquity\",\"?\")}')
except Exception as e:
    print(f'ERROR: {e}')
    print(sys.stdin.read()[:500])
" 2>/dev/null || echo "Failed to query API"

echo ""
echo "=== 6. WHAT btdd_d1 SYSTEM ACTUALLY IS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" \
  "SELECT ts.id, ts.name, COUNT(tsm.id) as member_count FROM trading_systems ts LEFT JOIN trading_system_members tsm ON tsm.system_id = ts.id WHERE ts.name = 'ALGOFUND::btdd-d1' OR ts.name = 'ALGOFUND_MASTER::BTDD_D1' GROUP BY ts.id"

echo ""
echo "=== 7. btdd_d1 MEMBERS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" \
  "SELECT tsm.strategy_id, s.name, tsm.is_enabled FROM trading_system_members tsm JOIN strategies s ON s.id = tsm.strategy_id WHERE tsm.system_id IN (SELECT id FROM trading_systems WHERE name = 'ALGOFUND::btdd-d1' OR name = 'ALGOFUND_MASTER::BTDD_D1') LIMIT 20"

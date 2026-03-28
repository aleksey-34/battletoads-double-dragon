#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== TENANTS ==="
sqlite3 $DB "SELECT id,slug,product_mode,assigned_api_key_name FROM tenants ORDER BY id;"

echo ""
echo "=== API KEYS ==="
sqlite3 $DB "SELECT id,name FROM api_keys ORDER BY id;"

echo ""
echo "=== ALGOFUND PROFILES ==="
sqlite3 $DB "SELECT ap.id, ap.tenant_id, t.slug, ap.assigned_api_key_name, ap.execution_api_key_name, ap.published_system_name, ap.requested_enabled, ap.actual_enabled FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id ORDER BY ap.id;"

echo ""
echo "=== TRADING SYSTEMS with ALGOFUND_MASTER ==="
sqlite3 $DB "SELECT ts.id, ak.name as api_key, ts.name, ts.is_active FROM trading_systems ts JOIN api_keys ak ON ak.id=ts.api_key_id WHERE ts.name LIKE 'ALGOFUND_MASTER%' ORDER BY ts.id DESC LIMIT 10;"

echo ""
echo "=== ALGOFUND_ACTIVE_SYSTEMS ==="
sqlite3 $DB "SELECT * FROM algofund_active_systems ORDER BY id DESC LIMIT 10;" 2>/dev/null || echo "(table not found)"

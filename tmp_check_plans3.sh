#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== TABLES ==="
sqlite3 database.db ".tables"
echo "=== TENANTS ==="
sqlite3 database.db "SELECT slug,product_mode,status,deposit_cap_override FROM tenants;"
echo "=== SUBSCRIPTIONS? ==="
sqlite3 database.db ".schema subscriptions" 2>&1 || echo "no subscriptions table"
sqlite3 database.db ".schema tenant_plans" 2>&1 || echo "no tenant_plans table"
echo "=== How plan links to tenant ==="
# search for plan reference in algofund flow
sqlite3 database.db "SELECT ap.id, t.slug, ap.risk_multiplier, ap.actual_enabled, ap.published_system_name FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id;"

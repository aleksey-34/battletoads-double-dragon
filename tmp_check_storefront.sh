#!/bin/bash
echo "=== PUBLISHED OFFERS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT key, substr(value,1,500) as val FROM app_runtime_flags WHERE key LIKE 'offer.store%'"

echo ""
echo "=== ALGOFUND ACTIVE SYSTEMS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT system_name, is_enabled FROM algofund_active_systems"

echo ""
echo "=== STRATEGY CLIENT PROFILES ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT tenant_id, mode, substr(active_offer_ids,1,200) as offers, is_active FROM strategy_client_profiles"

echo ""
echo "=== CLIENT ALGOFUND PROFILES ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT tenant_id, published_system_name, is_active, risk_multiplier FROM algofund_profiles"

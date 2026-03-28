#!/usr/bin/env bash
set -euo pipefail

DB="/opt/battletoads-double-dragon/backend/database.db"
TOKEN="SuperSecure2026Admin!"
BASE="http://127.0.0.1:3001"

section() {
	printf '\n=== %s ===\n' "$1"
}

query() {
	local sql="$1"
	printf '%s\n' "$sql" | sqlite3 -header -column "$DB"
}

section "API keys"
query "SELECT id, name FROM api_keys WHERE name IN ('BTDD_D1','BTDD_M1') ORDER BY name;"

section "Trading systems on BTDD keys"
query "SELECT ts.id, ts.name, ak.name AS api_key_name, ts.is_active, ts.max_members, ts.updated_at FROM trading_systems ts JOIN api_keys ak ON ak.id = ts.api_key_id WHERE ak.name IN ('BTDD_D1','BTDD_M1') ORDER BY ak.name, ts.is_active DESC, ts.id DESC;"

section "Enabled strategies on BTDD keys"
query "SELECT s.id, s.name, ak.name AS api_key_name, s.is_active, s.base_symbol, s.quote_symbol, s.updated_at FROM strategies s JOIN api_keys ak ON ak.id = s.api_key_id WHERE ak.name IN ('BTDD_D1','BTDD_M1') AND COALESCE(s.is_active, 0) = 1 ORDER BY ak.name, s.id DESC LIMIT 50;"

section "Tenants assigned to BTDD keys"
query "SELECT id, slug, display_name, product_mode, assigned_api_key_name FROM tenants WHERE assigned_api_key_name IN ('BTDD_D1','BTDD_M1') ORDER BY id;"

section "Algofund profiles bound to BTDD keys"
query "SELECT tenant_id, assigned_api_key_name, execution_api_key_name, requested_enabled, actual_enabled, published_system_name FROM algofund_profiles WHERE assigned_api_key_name IN ('BTDD_D1','BTDD_M1') OR execution_api_key_name IN ('BTDD_D1','BTDD_M1') ORDER BY tenant_id;"

section "Strategy client profiles bound to BTDD keys"
query "SELECT tenant_id, assigned_api_key_name, requested_enabled, actual_enabled, active_system_profile_id FROM strategy_client_profiles WHERE assigned_api_key_name IN ('BTDD_D1','BTDD_M1') ORDER BY tenant_id;"

section "Copytrading profiles using BTDD keys"
query "SELECT tenant_id, master_api_key_name FROM copytrading_profiles WHERE master_api_key_name IN ('BTDD_D1','BTDD_M1') ORDER BY tenant_id;" || true

section "Recent runtime events for BTDD keys"
query "SELECT api_key_name, event_type, strategy_id, substr(message, 1, 120) AS message, datetime(created_at / 1000, 'unixepoch') AS created_at_utc FROM strategy_runtime_events WHERE api_key_name IN ('BTDD_D1','BTDD_M1') ORDER BY created_at DESC LIMIT 20;"

section "Live positions BTDD_D1"
curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/positions/BTDD_D1" || true
printf '\n'

section "Live positions BTDD_M1"
curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/positions/BTDD_M1" || true
printf '\n'

section "Monitoring latest BTDD_D1"
curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/monitoring/latest/BTDD_D1" || true
printf '\n'

section "Monitoring latest BTDD_M1"
curl -s -H "Authorization: Bearer ${TOKEN}" "${BASE}/api/monitoring/latest/BTDD_M1" || true
printf '\n'

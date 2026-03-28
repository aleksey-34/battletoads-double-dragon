#!/bin/bash
# Fix BTDD_D1 algofund profile: enable tenant btdd-d1 (id=41003) profile
# linking it to the existing master system that's already actively trading
# This is ADDITIVE - does not stop any running strategies or positions

DB=/opt/battletoads-double-dragon/backend/database.db
SYSTEM_NAME="ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v"
PROFILE_ID=20499
TENANT_ID=41003
API_KEY="BTDD_D1"

echo "=== Current state of btdd-d1 profile ==="
sqlite3 $DB "SELECT * FROM algofund_profiles WHERE id=$PROFILE_ID;"

echo ""
echo "=== Fixing profile: set requested_enabled=1, actual_enabled=1, published_system_name, execution_api_key_name ==="
sqlite3 $DB "UPDATE algofund_profiles 
  SET published_system_name='$SYSTEM_NAME',
      execution_api_key_name='$API_KEY',
      assigned_api_key_name='$API_KEY',
      requested_enabled=1,
      actual_enabled=1,
      updated_at=CURRENT_TIMESTAMP
  WHERE id=$PROFILE_ID AND tenant_id=$TENANT_ID;"

echo ""
echo "=== Verify algofund_active_systems for this profile ==="
ACTIVE_EXISTS=$(sqlite3 $DB "SELECT COUNT(*) FROM algofund_active_systems WHERE profile_id=$PROFILE_ID;")
echo "Active systems for profile $PROFILE_ID: $ACTIVE_EXISTS"

if [ "$ACTIVE_EXISTS" = "0" ]; then
  echo "=== Inserting algofund_active_systems row ==="
  sqlite3 $DB "INSERT INTO algofund_active_systems (profile_id, system_name, risk_multiplier, is_enabled, created_by, created_at, updated_at)
    VALUES ($PROFILE_ID, '$SYSTEM_NAME', 1.0, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);"
fi

echo ""
echo "=== Final state ==="
sqlite3 $DB "SELECT ap.id, ap.tenant_id, t.slug, ap.assigned_api_key_name, ap.execution_api_key_name, ap.published_system_name, ap.requested_enabled, ap.actual_enabled FROM algofund_profiles ap JOIN tenants t ON t.id=ap.tenant_id WHERE ap.id=$PROFILE_ID;"
echo ""
sqlite3 $DB "SELECT * FROM algofund_active_systems WHERE profile_id=$PROFILE_ID;"
echo ""
echo "=== Done. BTDD_D1 now trades as client card btdd-d1 ==="

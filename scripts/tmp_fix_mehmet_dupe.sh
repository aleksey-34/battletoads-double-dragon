DB=/opt/battletoads-double-dragon/backend/database.db
echo '=== BEFORE ==='
sqlite3 -header -column "$DB" "select ap.tenant_id, t.display_name, ap.published_system_name, aas.system_name, aas.is_enabled, aas.assigned_by, aas.updated_at from algofund_profiles ap join tenants t on t.id=ap.tenant_id left join algofund_active_systems aas on aas.profile_id=ap.id where ap.tenant_id in (1288,41003,41170,41232,43430) order by ap.tenant_id, aas.id;"

sqlite3 "$DB" "update algofund_active_systems set is_enabled=0, updated_at=CURRENT_TIMESTAMP where profile_id in (select id from algofund_profiles where tenant_id=1288) and system_name != (select published_system_name from algofund_profiles where tenant_id=1288) and coalesce(is_enabled,1)=1;"

echo '=== AFTER ==='
sqlite3 -header -column "$DB" "select ap.tenant_id, t.display_name, ap.published_system_name, aas.system_name, aas.is_enabled, aas.assigned_by, aas.updated_at from algofund_profiles ap join tenants t on t.id=ap.tenant_id left join algofund_active_systems aas on aas.profile_id=ap.id where ap.tenant_id in (1288,41003,41170,41232,43430) order by ap.tenant_id, aas.id;"
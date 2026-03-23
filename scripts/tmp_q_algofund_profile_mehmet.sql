select t.id, t.slug, a.requested_enabled, a.actual_enabled, a.assigned_api_key_name, a.published_system_name
from tenants t
join algofund_profiles a on a.tenant_id = t.id
where lower(t.slug) like '%mehmet%' or lower(t.display_name) like '%mehmet%';

SELECT ap.id, t.slug, ap.requested_enabled, ap.actual_enabled, ap.published_system_name 
FROM algofund_profiles ap 
JOIN tenants t ON t.id = ap.tenant_id 
WHERE t.slug LIKE 'btdd%' OR t.display_name LIKE 'BTDD%' 
ORDER BY t.id;

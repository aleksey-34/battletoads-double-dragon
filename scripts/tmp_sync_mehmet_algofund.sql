UPDATE algofund_profiles
SET actual_enabled = 1,
    published_system_name = 'ALGOFUND::mehmet-bingx',
    assigned_api_key_name = 'Mehmet_Bingx',
    updated_at = CURRENT_TIMESTAMP
WHERE tenant_id = 1288;

SELECT tenant_id, assigned_api_key_name, published_system_name, requested_enabled, actual_enabled, updated_at
FROM algofund_profiles
WHERE tenant_id = 1288;

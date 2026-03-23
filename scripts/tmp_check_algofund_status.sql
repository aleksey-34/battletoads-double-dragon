SELECT t.id,
       t.slug,
       t.display_name,
       ap.requested_enabled,
       ap.actual_enabled,
       ap.published_system_name,
       ap.updated_at
FROM algofund_profiles ap
JOIN tenants t ON t.id = ap.tenant_id
WHERE t.slug = 'mehmet-bingx';

SELECT r.id,
       r.request_type,
       r.status,
       r.note,
       r.decision_note,
       r.created_at,
       r.decided_at
FROM algofund_start_stop_requests r
JOIN tenants t ON t.id = r.tenant_id
WHERE t.slug = 'mehmet-bingx'
ORDER BY r.id DESC
LIMIT 5;

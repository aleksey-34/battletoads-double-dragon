select r.id, r.tenant_id, r.request_type, r.status, substr(r.decision_note, 1, 180) as decision_note_head, r.created_at, r.decided_at
from algofund_start_stop_requests r
join tenants t on t.id = r.tenant_id
where lower(t.slug) like '%mehmet%' or lower(t.display_name) like '%mehmet%'
order by r.id desc
limit 10;

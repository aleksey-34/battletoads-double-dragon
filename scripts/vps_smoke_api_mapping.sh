#!/usr/bin/env bash
set -euo pipefail

DB="/opt/battletoads-double-dragon/backend/database.db"

echo "API_STATE=$(systemctl is-active btdd-api 2>/dev/null || true)"
echo "NGINX_STATE=$(systemctl is-active nginx 2>/dev/null || true)"

echo "----- API /health -----"
curl -sS -o /tmp/btdd_health.json -w "HTTP:%{http_code}\n" http://127.0.0.1:3001/health || true
sed -n '1,40p' /tmp/btdd_health.json || true

echo "----- API admin summary -----"
curl -sS -o /tmp/btdd_summary.json -w "HTTP:%{http_code}\n" -H "Authorization: Bearer SuperSecure2026Admin!" http://127.0.0.1:3001/api/saas/admin/summary || true
python3 - <<'PY'
import json
try:
    d=json.load(open('/tmp/btdd_summary.json','r',encoding='utf-8'))
    print('summary_keys=', list(d.keys())[:20])
    alg=d.get('algofund') or {}
    print('algofund_keys=', list(alg.keys())[:20])
except Exception as e:
    print('summary_parse_error=', e)
PY

echo "----- Ali/Ruslan mapping -----"
sqlite3 -header -column "$DB" "
SELECT
  t.id AS tenant_id,
  t.display_name,
  t.assigned_api_key_name AS tenant_api,
  COALESCE(ap.assigned_api_key_name,'') AS profile_api,
  COALESCE(ap.execution_api_key_name,'') AS exec_api
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id=t.id
WHERE t.display_name IN ('Ali','Ruslan')
ORDER BY t.id;
"

echo "----- Global mismatches (should be empty) -----"
sqlite3 -header -column "$DB" "
SELECT
  t.id AS tenant_id,
  t.display_name,
  t.assigned_api_key_name AS tenant_api,
  COALESCE(ap.assigned_api_key_name,'') AS profile_api,
  COALESCE(ap.execution_api_key_name,'') AS exec_api
FROM tenants t
JOIN algofund_profiles ap ON ap.tenant_id=t.id
WHERE t.product_mode='algofund_client'
  AND (
    COALESCE(ap.assigned_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
    OR COALESCE(ap.execution_api_key_name,'') <> COALESCE(t.assigned_api_key_name,'')
  )
ORDER BY t.id;
"

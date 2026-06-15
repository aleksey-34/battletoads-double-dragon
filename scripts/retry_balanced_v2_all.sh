#!/bin/bash
set -euo pipefail
DB="${DB:-/opt/battletoads-double-dragon/backend/database.db}"
LOG="/tmp/retry_materialize_cleanup_$(date +%Y%m%d_%H%M%S).log"
echo "START $(date -u)" | tee "$LOG"

mapfile -t IDS < <(python3 -c "
import sqlite3
db=sqlite3.connect('$DB')
c=db.cursor()
c.execute('''
SELECT t.id FROM algofund_profiles ap
JOIN tenants t ON t.id=ap.tenant_id
WHERE ap.published_system_name LIKE \"%balanced-portfolio-v2%\" AND ap.requested_enabled=1
ORDER BY t.slug
''')
for r in c.fetchall():
    print(r[0])
")

echo "Tenants: ${#IDS[@]}" | tee -a "$LOG"
for id in "${IDS[@]}"; do
  echo "=== tenant $id ===" | tee -a "$LOG"
  start=$(date +%s)
  curl -s -m 900 -X POST "http://127.0.0.1:3001/api/saas/algofund/${id}/retry-materialize" \
    -H "Content-Type: application/json" >>"$LOG" 2>&1 || echo "FAIL curl $id" | tee -a "$LOG"
  echo "OK in $(( $(date +%s) - start ))s" | tee -a "$LOG"
  sleep 5
done

if [[ -f /tmp/check_balanced_v2_health.py ]]; then
  python3 /tmp/check_balanced_v2_health.py | tee -a "$LOG"
fi
echo "DONE $(date -u)" | tee -a "$LOG"

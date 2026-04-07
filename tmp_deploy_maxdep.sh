#!/bin/bash
set -e
cd /opt/battletoads-double-dragon
git pull origin feature/ts-architecture-refactor
cd backend
npm run build 2>&1 | tail -5
systemctl restart btdd-api btdd-runtime btdd-research
echo "=== Services restarted ==="
systemctl is-active btdd-api btdd-runtime btdd-research
echo "=== Verify BTDD_D1 max_deposit ==="
sqlite3 database.db "SELECT id, base_symbol, max_deposit FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1 LIMIT 3;"

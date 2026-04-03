#!/bin/bash
set -e
cd /opt/battletoads-double-dragon
echo "=== GIT PULL ==="
git pull 2>&1 | tail -5
echo "=== BACKEND BUILD ==="
cd backend && npx tsc 2>&1 | tail -3
echo "=== FRONTEND BUILD ==="
cd ../frontend && rm -rf node_modules/.cache
CI=true npx react-scripts build 2>&1 | tail -10
echo "=== RESTART ==="
systemctl restart btdd-api
sleep 2
systemctl is-active btdd-api
echo "=== COMMIT ==="
git -C /opt/battletoads-double-dragon log --oneline -1
echo "=== DONE ==="

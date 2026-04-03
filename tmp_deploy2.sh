#!/bin/bash
echo "=== GIT PULL ==="
cd /opt/battletoads-double-dragon && git pull 2>&1 | tail -5
echo "=== TSC BUILD ==="
cd backend && npx tsc 2>&1 | tail -3
echo "=== RESTART ==="
systemctl restart btdd-api
sleep 2
systemctl is-active btdd-api
echo "=== COMMIT ==="
git log --oneline -1
echo "=== DONE ==="

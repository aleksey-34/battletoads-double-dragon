#!/bin/bash
set -e

echo "=== REBUILDING BACKEND ==="
cd /opt/battletoads-double-dragon/backend
npx tsc 2>&1
echo "BACKEND_OK"

echo "=== REBUILDING FRONTEND ==="
cd /opt/battletoads-double-dragon/frontend
npm run build 2>&1 | tail -5
echo "FRONTEND_BUILD_DONE"

echo "=== COPYING TO NGINX ==="
cp -r build/* /var/www/battletoads-double-dragon/
grep -o 'main\.[a-z0-9]*\.js' /var/www/battletoads-double-dragon/index.html | head -n 1

echo "=== RESTARTING SERVICES ==="
systemctl restart btdd-api
systemctl restart btdd-runtime
sleep 2
systemctl is-active btdd-api
systemctl is-active btdd-runtime
echo "=== DEPLOY COMPLETE ==="

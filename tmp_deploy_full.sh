#!/bin/bash
set -e
cd /opt/battletoads-double-dragon

echo "=== GIT PULL ==="
git pull origin feature/ts-architecture-refactor 2>&1 | tail -5

echo "=== BACKEND BUILD ==="
cd backend
npx tsc --noEmit 2>&1 | tail -10 || true
cd ..

echo "=== RESTART API ==="
systemctl restart btdd-api 2>/dev/null || true
sleep 2

echo "=== FRONTEND BUILD ==="
rm -f /tmp/btdd_build_status.txt
cd frontend
rm -rf build
NODE_OPTIONS=--max-old-space-size=2048 npm run build > /tmp/btdd_front_build.log 2>&1
cp -r build/* /var/www/battletoads-double-dragon/
echo BUILD_OK > /tmp/btdd_build_status.txt

echo "=== BUNDLE ==="
grep -o 'main\.[a-z0-9]*\.js' /var/www/battletoads-double-dragon/index.html | head -1

echo "=== DONE ==="

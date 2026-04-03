#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "=== TSC BUILD ==="
npx tsc 2>&1 | tail -5
echo "=== BUILD DONE, exit=$? ==="
echo "=== RESTART ==="
systemctl restart btdd-api
sleep 2
systemctl is-active btdd-api
echo "=== EXCHANGE.JS DATE ==="
ls -la dist/bot/exchange.js | awk '{print $6,$7,$8}'
echo "=== DONE ==="

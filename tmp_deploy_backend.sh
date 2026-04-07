#!/bin/bash
set -e
cd /opt/battletoads-double-dragon
git pull origin feature/ts-architecture-refactor
cd backend
npm run build 2>&1 | tail -5
echo "BUILD_OK"
systemctl restart btdd-api btdd-runtime
sleep 2
systemctl is-active btdd-api btdd-runtime
echo "DEPLOY_DONE"

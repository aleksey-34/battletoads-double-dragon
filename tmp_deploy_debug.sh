#!/bin/bash
set -e
cd /opt/battletoads-double-dragon
git pull origin feature/ts-architecture-refactor
cd backend
npm run build 2>&1 | tail -3
systemctl restart btdd-runtime
echo "Restarted btdd-runtime"
systemctl is-active btdd-runtime

#!/usr/bin/env bash
set -euo pipefail

cd /opt/battletoads-double-dragon/backend
npm run build
systemctl restart btdd-api
sleep 2
echo "BTDD_API_STATE=$(systemctl is-active btdd-api 2>/dev/null || true)"

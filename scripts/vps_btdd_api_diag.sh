#!/usr/bin/env bash
set -uo pipefail

echo "BTDD_API_STATE=$(systemctl is-active btdd-api 2>/dev/null || true)"
echo "----- systemctl status -----"
systemctl --no-pager --full status btdd-api | sed -n '1,40p' || true
echo "----- journal tail -----"
journalctl -u btdd-api --no-pager -n 80 || true

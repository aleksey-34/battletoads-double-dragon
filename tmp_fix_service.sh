#!/bin/bash
set -e

# Fix EADDRINUSE: add ExecStartPre to kill port before starting API
SERVICE="/etc/systemd/system/btdd-api.service"

# Remove any existing ExecStartPre lines
sed -i '/^ExecStartPre=/d' "$SERVICE"

# Add ExecStartPre before ExecStart
sed -i '/^ExecStart=/i ExecStartPre=/bin/bash -c "fuser -k 3001/tcp 2>/dev/null || true; sleep 1"' "$SERVICE"

# Increase RestartSec from 5 to 8
sed -i 's/^RestartSec=5$/RestartSec=8/' "$SERVICE"

systemctl daemon-reload
echo "Service file updated:"
grep -E 'ExecStart|RestartSec' "$SERVICE"

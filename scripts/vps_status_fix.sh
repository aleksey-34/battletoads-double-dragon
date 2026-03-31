#!/usr/bin/env bash
set -euo pipefail

echo "HOST_OK"
date -u
btdd_api_state="$(systemctl is-active btdd-api 2>/dev/null || true)"
nginx_state="$(systemctl is-active nginx 2>/dev/null || true)"
echo "BTDD_API=${btdd_api_state:-unknown}"
echo "NGINX=${nginx_state:-unknown}"

if [[ -f /opt/battletoads-double-dragon/frontend/build/index.html ]]; then
  echo "FRONT_BUILD=present"
else
  echo "FRONT_BUILD=missing"
fi

bundle="$(ls -1 /var/www/battletoads-double-dragon/static/js/main.*.js 2>/dev/null | head -n 1 || true)"
if [[ -n "$bundle" ]]; then
  echo "NGINX_BUNDLE=$bundle"
else
  echo "NGINX_BUNDLE=missing"
fi

#!/bin/bash
echo "=== NGINX CONFIG FILES ==="
ls -la /etc/nginx/sites-enabled/ 2>/dev/null
ls -la /etc/nginx/conf.d/ 2>/dev/null

echo "=== MAIN CONFIG ==="
cat /etc/nginx/sites-enabled/battletoads* 2>/dev/null || cat /etc/nginx/sites-enabled/default 2>/dev/null || cat /etc/nginx/conf.d/battletoads* 2>/dev/null

echo "=== DONE ==="

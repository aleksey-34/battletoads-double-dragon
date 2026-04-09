#!/bin/bash
set -e

cat > /etc/nginx/sites-enabled/battletoads-double-dragon.conf << 'NGINX'
server {
  listen 80;
  server_name battletoads.top www.battletoads.top 176.57.184.98;
  return 301 https://battletoads.top$request_uri;
}

server {
  listen 443 ssl http2;
  server_name battletoads.top www.battletoads.top 176.57.184.98;

  ssl_certificate     /etc/ssl/cloudflare/origin.pem;
  ssl_certificate_key /etc/ssl/cloudflare/origin.key;
  ssl_protocols       TLSv1.2 TLSv1.3;
  ssl_ciphers         HIGH:!aNULL:!MD5;

  root /var/www/battletoads-double-dragon;
  index index.html;

  gzip on;
  gzip_vary on;
  gzip_proxied any;
  gzip_comp_level 6;
  gzip_types text/plain text/css application/json application/javascript text/xml application/xml application/xml+rss text/javascript image/svg+xml;

  # Hashed static assets (main.abc123.js) — cache aggressively on both CDN and browser
  location /static/ {
    expires 365d;
    add_header Cache-Control "public, max-age=31536000, s-maxage=31536000, immutable";
    try_files $uri =404;
  }

  # Other static files (favicon, manifest, logos) — cache moderately
  location ~* \.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|webp)$ {
    expires 30d;
    add_header Cache-Control "public, max-age=2592000, s-maxage=2592000";
    try_files $uri =404;
  }

  location /api/ {
    limit_req zone=api_limit burst=50 nodelay;
    proxy_pass http://127.0.0.1:3001/api/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_read_timeout 120s;
    add_header Cache-Control "no-store, no-cache";
  }

  location /admin-docs/ {
    alias /var/www/btdd-admin-docs/;
    index index.html;
    add_header X-Frame-Options SAMEORIGIN;
  }

  location = /admin-docs {
    return 301 /admin-docs/;
  }

  # HTML — never cache (so new deploys pick up instantly)
  location / {
    try_files $uri /index.html;
    add_header Cache-Control "no-cache, no-store, must-revalidate";
    add_header Pragma "no-cache";
  }
}
NGINX

echo "Config written. Testing..."
nginx -t 2>&1
echo "Reloading nginx..."
systemctl reload nginx
echo "DONE"

# Verify headers
sleep 1
echo "=== STATIC CACHE HEADER ==="
curl -sI https://battletoads.top/static/js/main.22731d78.js 2>/dev/null | grep -i cache-control || echo "(could not check)"
echo "=== HTML CACHE HEADER ==="
curl -sI https://battletoads.top/ 2>/dev/null | grep -i cache-control || echo "(could not check)"

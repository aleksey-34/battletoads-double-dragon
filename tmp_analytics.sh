#!/bin/bash
echo "=== NGINX LOG STATS ==="
LOG=/var/log/nginx/access.log
if [ -f "$LOG" ]; then
  TOTAL=$(wc -l < "$LOG")
  echo "Total requests: $TOTAL"
  echo "Landing page hits: $(grep -c 'GET / HTTP' "$LOG")"
  echo "Client page hits: $(grep -c '/client' "$LOG")"
  echo "API auth hits: $(grep -c '/api/auth/client' "$LOG")"
  echo "Storefront hits: $(grep -c '/api/storefront' "$LOG")"
  echo "Register attempts: $(grep -c '/api/auth/client/register' "$LOG")"
  echo ""
  echo "=== UNIQUE IPs TODAY ==="
  TODAY=$(date +%d/%b/%Y)
  grep "$TODAY" "$LOG" | awk '{print $1}' | sort -u | wc -l
  echo " unique IPs today"
  echo ""
  echo "=== LAST 10 ENTRIES ==="
  tail -10 "$LOG"
else
  echo "No access log found"
  ls /var/log/nginx/ 2>/dev/null
fi

echo ""
echo "=== CLIENT REGISTRATIONS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, email, created_at FROM client_users ORDER BY created_at DESC LIMIT 15;"

echo ""
echo "=== STRATEGY HEALTH ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, name, is_active FROM strategies WHERE is_active=1 LIMIT 10;"

#!/bin/bash
echo "=== ALL database.db FILES ==="
find / -name "database.db" 2>/dev/null

echo ""
echo "=== DB SIZE AND HASH ==="
ls -la /opt/battletoads-double-dragon/backend/database.db
md5sum /opt/battletoads-double-dragon/backend/database.db

echo ""
echo "=== ENV DB PATH ==="
grep -r "database" /opt/battletoads-double-dragon/backend/.env 2>/dev/null || echo "No .env"
grep -r "DATABASE" /opt/battletoads-double-dragon/backend/.env 2>/dev/null || echo "No DATABASE in .env"

echo ""
echo "=== API PROCESS DB ==="
lsof -c node 2>/dev/null | grep database.db | head -5

echo ""
echo "=== BTDD API systemd ==="
cat /etc/systemd/system/btdd-api.service 2>/dev/null | head -20

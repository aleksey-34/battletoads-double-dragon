#!/bin/bash
echo "=== ALGOFUND MASTER TRADING SYSTEMS ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db ".headers on" "SELECT id, name, api_key_name FROM trading_systems WHERE name LIKE 'ALGOFUND_MASTER%' ORDER BY name"

echo ""
echo "=== ALL TRADING SYSTEMS COUNT ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT COUNT(*) as total FROM trading_systems"

echo ""
echo "=== ALL TS NAMES WITH ALGOFUND ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, name FROM trading_systems WHERE UPPER(name) LIKE '%ALGOFUND%' OR UPPER(name) LIKE '%MASTER%' ORDER BY name"

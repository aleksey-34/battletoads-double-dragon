#!/bin/bash
echo "=== trading_systems ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, api_key_id, name, is_active FROM trading_systems LIMIT 20"

echo ""
echo "=== ALGOFUND_MASTER systems only ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, api_key_id, name, is_active FROM trading_systems WHERE name LIKE 'ALGOFUND_MASTER%' LIMIT 20"

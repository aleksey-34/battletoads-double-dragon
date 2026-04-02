#!/bin/bash
echo "=== PROFILE ==="
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id, tenant_id, hedge_accounts_json, enabled, target_mode, target_value FROM synctrade_profiles"
echo "=== SESSIONS ==="
sqlite3 /opt/battletoads-double-dragon/database.db "SELECT id, profile_id, status FROM synctrade_sessions"
echo "=== API LOGS ==="
journalctl -u btdd-api --no-pager --since '2 min ago' | grep -i -E 'synctrade|hedge|error|Error' | tail -20

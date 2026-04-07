#!/bin/bash
cd /opt/battletoads-double-dragon/backend
echo "BEFORE:"
sqlite3 database.db "SELECT max_deposit FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1 LIMIT 3;"
sqlite3 database.db "UPDATE strategies SET max_deposit=200000 WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1;"
echo "AFTER:"
sqlite3 database.db "SELECT id, base_symbol, max_deposit FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1;"
echo "Changes: $(sqlite3 database.db 'SELECT changes();')"

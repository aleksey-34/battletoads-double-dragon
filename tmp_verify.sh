#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, base_symbol, max_deposit FROM strategies WHERE api_key_id=(SELECT id FROM api_keys WHERE name='BTDD_D1') AND is_runtime=1 LIMIT 3;"

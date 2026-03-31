#!/usr/bin/env bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db <<'SQL'
.mode line
.headers on
SELECT id, api_key_id, name, is_active, created_at, updated_at 
FROM trading_systems 
WHERE name LIKE '%high-trade-curated%' 
   OR name LIKE '%ARCHIVED%BTDD%'
ORDER BY updated_at DESC LIMIT 30;
SQL

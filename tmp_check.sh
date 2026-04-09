#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db <<'SQL'
.mode column
SELECT id, name, is_active FROM strategies WHERE is_archived=0 AND name LIKE '%SAAS%';
SQL

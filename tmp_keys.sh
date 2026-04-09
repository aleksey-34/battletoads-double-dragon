#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT key FROM app_runtime_flags WHERE key LIKE '%catalog%';"
echo "---"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT key FROM app_runtime_flags WHERE key LIKE '%offer%';"

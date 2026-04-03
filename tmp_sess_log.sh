#!/bin/bash
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT id, status FROM synctrade_sessions ORDER BY id DESC LIMIT 3"
echo "---"
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT log_json FROM synctrade_sessions ORDER BY id DESC LIMIT 1"

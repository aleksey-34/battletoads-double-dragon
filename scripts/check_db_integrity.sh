#!/bin/bash
# Проверка целостности БД battletoads-double-dragon
# Сохрани как scripts/check_db_integrity.sh и запускай на VPS из backend/

set -e

DB_FILE="../backend/db.sqlite"

if [ ! -f "$DB_FILE" ]; then
  echo "[ERROR] $DB_FILE не найден!"
  exit 1
fi

sqlite3 "$DB_FILE" <<SQL
PRAGMA integrity_check;
SELECT 'trading_systems', count(*) FROM trading_systems;
SELECT 'client_attachments', count(*) FROM client_attachments;
SELECT 'user_settings', count(*) FROM user_settings;
SQL

#!/bin/bash
# Инициализация структуры БД для battletoads-double-dragon (минимальный набор)
# Сохрани как scripts/init_db_structure.sh и запускай на VPS из backend/

set -e

DB_FILE="../backend/db.sqlite"

if [ -f "$DB_FILE" ]; then
  echo "[WARN] $DB_FILE уже существует, будет перезаписан!"
  mv "$DB_FILE" "$DB_FILE.bak.$(date +%Y%m%d%H%M%S)"
fi

echo "Создаём новую БД: $DB_FILE"
sqlite3 "$DB_FILE" <<SQL
CREATE TABLE trading_systems (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT UNIQUE NOT NULL,
  title TEXT,
  params TEXT,
  status TEXT,
  published_at TEXT
);

CREATE TABLE client_attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  trading_system_id INTEGER NOT NULL,
  client_id TEXT NOT NULL,
  attached_at TEXT,
  FOREIGN KEY(trading_system_id) REFERENCES trading_systems(id)
);

CREATE TABLE user_settings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  client_attachment_id INTEGER NOT NULL,
  risk_multiplier REAL DEFAULT 1.0,
  trade_frequency REAL DEFAULT 1.0,
  extra_params TEXT,
  FOREIGN KEY(client_attachment_id) REFERENCES client_attachments(id)
);
SQL

echo "[OK] Структура БД создана."

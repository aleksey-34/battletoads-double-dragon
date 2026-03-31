#!/bin/bash
# Импорт карточек ТС из JSON-файла в БД (минимальный пример)
# Сохрани как scripts/import_ts_cards.sh и запускай на VPS из backend/
# Требует jq (apt install jq)

set -e

DB_FILE="../backend/db.sqlite"
JSON_FILE="../results/btdd_d1_client_catalog_2026-03-28T13-15-00-000Z.json" # актуальный файл client_catalog

if [ ! -f "$DB_FILE" ]; then
  echo "[ERROR] $DB_FILE не найден!"
  exit 1
fi
if [ ! -f "$JSON_FILE" ]; then
  echo "[ERROR] $JSON_FILE не найден!"
  exit 1
fi

echo "Импорт карточек из $JSON_FILE в $DB_FILE..."

for section in mono synth curated; do
  jq -c ".clientCatalog.$section[]" "$JSON_FILE" | while read -r card; do
    code=$(echo "$card" | jq -r '.offerId // empty')
    title=$(echo "$card" | jq -r '.titleRu // empty')
    params=$(echo "$card" | jq -c '.')
    status="published"
    published_at=$(date +%Y-%m-%dT%H:%M:%S)
    if [ -n "$code" ]; then
      sqlite3 "$DB_FILE" "INSERT OR IGNORE INTO trading_systems (code, title, params, status, published_at) VALUES ('$code', '$title', '$params', '$status', '$published_at');"
      echo "[OK] $code ($section)"
    fi
  done
done

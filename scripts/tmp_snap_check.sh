#!/bin/bash
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== ts_backtest_snapshots (first 800 chars) ==="
sqlite3 "$DB" "SELECT substr(value,1,800) FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshots';"

echo ""
echo "=== ts_backtest_snapshot (singular) ==="
sqlite3 "$DB" "SELECT value FROM app_runtime_flags WHERE key='offer.store.ts_backtest_snapshot';"

echo ""
echo "=== snapshot_refresh_state ==="
sqlite3 "$DB" "SELECT value FROM app_runtime_flags WHERE key='offer.store.snapshot_refresh_state';"

#!/bin/bash
RDB=/opt/battletoads-double-dragon/research.db
DB=/opt/battletoads-double-dragon/backend/database.db

echo "=== SWEEP RUNS (last 5) ==="
sqlite3 -header -column "$RDB" "SELECT id, name, status, started_at, finished_at FROM sweep_runs ORDER BY id DESC LIMIT 5;"

echo ""
echo "=== BACKTEST RUNS (last 10) ==="
sqlite3 -header -column "$RDB" "SELECT id, sweep_run_id, status, started_at, finished_at FROM backtest_runs ORDER BY id DESC LIMIT 10;"

echo ""
echo "=== TOTAL BACKTESTS ==="
sqlite3 "$RDB" "SELECT COUNT(*) FROM backtest_runs;"

echo ""
echo "=== BACKTEST SNAPSHOTS IN app_runtime_flags ==="
sqlite3 -header -column "$DB" "SELECT key, length(value) as val_len, updated_at FROM app_runtime_flags WHERE key LIKE '%backtest%' OR key LIKE '%snapshot%';"

echo ""
echo "=== ALL RUNTIME FLAGS KEYS ==="
sqlite3 "$DB" "SELECT key, updated_at FROM app_runtime_flags ORDER BY updated_at DESC LIMIT 20;"

echo ""
echo "=== RESEARCH SCHEDULER JOBS ==="
sqlite3 -header -column "$RDB" "SELECT * FROM research_scheduler_jobs ORDER BY rowid DESC LIMIT 10;"

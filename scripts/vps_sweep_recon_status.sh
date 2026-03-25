#!/usr/bin/env bash
set -euo pipefail

VPS_HOST="${1:-root@176.57.184.98}"
RESEARCH_DB="/opt/battletoads-double-dragon/research.db"
RUNTIME_DB="/opt/battletoads-double-dragon/backend/database.db"

ssh "$VPS_HOST" "
set -euo pipefail

echo '[utc]'
date -u

echo '[scheduler daily_incremental_sweep]'
sqlite3 -header -column '$RESEARCH_DB' \"
  select id,job_key,is_enabled,hour_utc,minute_utc,last_run_at,last_status,next_run_at,updated_at
  from research_scheduler_jobs
  where job_key='daily_incremental_sweep'
  order by id desc
  limit 1;
\"

echo '[latest full_historical_sweep jobs]'
sqlite3 -header -column '$RESEARCH_DB' \"
  select id,status,processed_days,created_runs,skipped_days,progress_percent,started_at,finished_at,updated_at
  from research_backfill_jobs
  where job_key='full_historical_sweep'
  order by id desc
  limit 5;
\"

echo '[systemd services]'
systemctl is-active btdd-api btdd-research btdd-runtime

echo '[reconciliation pipeline counts]'
sqlite3 -header -column '$RUNTIME_DB' \"
  select 'live_trade_events' as table_name,count(*) as rows from live_trade_events
  union all
  select 'backtest_predictions',count(*) from backtest_predictions
  union all
  select 'drift_alerts',count(*) from drift_alerts
  union all
  select 'reconciliation_reports',count(*) from reconciliation_reports;
\"

echo '[latest reconciliation reports]'
sqlite3 -header -column '$RUNTIME_DB' \"
  select
    id,
    api_key_id,
    strategy_id,
    period_hours,
    samples_count,
    json_extract(recommendation_json,'$.recommendation') as recommendation,
    action_note,
    datetime(created_at/1000,'unixepoch') as created_at_utc
  from reconciliation_reports
  order by id desc
  limit 10;
\"
"
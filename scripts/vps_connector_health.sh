#!/usr/bin/env bash
set -euo pipefail

echo "=== UTC ==="
date -u

echo "\n=== Services ==="
systemctl is-active btdd-api || true
systemctl is-active btdd-runtime || true

echo "\n=== Active strategies by API key ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT a.name, COUNT(*) AS cnt FROM strategies s JOIN api_keys a ON a.id=s.api_key_id WHERE COALESCE(s.is_active,0)=1 GROUP BY a.name ORDER BY cnt DESC;"

echo "\n=== Last actions by API key (last 60 min) ==="
sqlite3 /opt/battletoads-double-dragon/backend/database.db "SELECT a.name, COUNT(*) AS recent_updates, SUM(CASE WHEN COALESCE(s.last_action,'') LIKE '%opened_%' THEN 1 ELSE 0 END) AS opened_actions, SUM(CASE WHEN COALESCE(s.last_action,'')='auto_cycle_failed' THEN 1 ELSE 0 END) AS failed_actions FROM strategies s JOIN api_keys a ON a.id=s.api_key_id WHERE COALESCE(s.is_active,0)=1 AND datetime(COALESCE(s.updated_at,'')) >= datetime('now','-60 minutes') GROUP BY a.name ORDER BY recent_updates DESC;"

echo "\n=== Runtime rate-limit log lines ==="
journalctl -u btdd-runtime -n 500 --no-pager | grep -Ei "100410|rate|limit|trade history|bingx|429|too many" | tail -120 || true

echo "\n=== API rate-limit log lines ==="
journalctl -u btdd-api -n 500 --no-pager | grep -Ei "100410|rate|limit|trade history|bingx|429|too many" | tail -120 || true

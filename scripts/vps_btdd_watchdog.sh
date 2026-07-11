#!/usr/bin/env bash
# BTDD VPS watchdog: alert + restart if API/runtime down or snapshots stale.
# Install: cron */5 * * * * root /opt/battletoads-double-dragon/scripts/vps_btdd_watchdog.sh
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
API_PORT="${API_PORT:-3001}"
TG_TOKEN="${BTDD_WATCHDOG_TG_TOKEN:-${TELEGRAM_ADMIN_BOT_TOKEN:-}}"
TG_CHAT="${BTDD_WATCHDOG_TG_CHAT:-${TELEGRAM_ADMIN_CHAT_ID:-}}"
# 45m was too aggressive: with ~20 WEEX keys monitoring takes >5m per cycle;
# restarting runtime on stale created a kill-loop (snapshots never refreshed).
STALE_MIN="${BTDD_WATCHDOG_STALE_MIN:-180}"
RESTART_ON_STALE="${BTDD_WATCHDOG_RESTART_ON_STALE:-0}"
LOG_TAG="[btdd-watchdog]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $LOG_TAG $*"; }

notify() {
  local msg="$1"
  log "$msg"
  if [[ -n "$TG_TOKEN" && -n "$TG_CHAT" ]]; then
    curl -sf -X POST "https://api.telegram.org/bot${TG_TOKEN}/sendMessage" \
      -d "chat_id=${TG_CHAT}" -d "parse_mode=HTML" \
      --data-urlencode "text=${msg}" >/dev/null 2>&1 || true
  fi
}

health_ok() {
  curl -sf -o /dev/null -w "" -H "Authorization: Bearer ${ADMIN_SWEEP_TOKEN:-btdd_admin_sweep_2026}" \
    "http://127.0.0.1:${API_PORT}/api/market-data/BTDD_D1?symbol=BTCUSDT&interval=4h&limit=2" 2>/dev/null
}

restart_unit() {
  local unit="$1"
  log "restarting $unit"
  systemctl restart "$unit" || true
  sleep 5
}

alerts=()

for unit in btdd-api btdd-runtime btdd-research; do
  if ! systemctl is-active --quiet "$unit"; then
    alerts+=("unit <b>${unit}</b> inactive")
    restart_unit "$unit"
  fi
done

if ! health_ok; then
  alerts+=("API health/market-data failed on :${API_PORT}")
  restart_unit btdd-api
  sleep 8
fi

if [[ -f "${APP_DIR}/backend/database.db" ]]; then
  stale=$(sqlite3 "${APP_DIR}/backend/database.db" "
    SELECT COUNT(*) FROM algofund_profiles ap
    JOIN tenants t ON t.id=ap.tenant_id
    LEFT JOIN api_keys a ON a.name=COALESCE(NULLIF(ap.execution_api_key_name,''), t.assigned_api_key_name)
    LEFT JOIN (
      SELECT api_key_id, MAX(datetime(recorded_at)) mx FROM monitoring_snapshots GROUP BY api_key_id
    ) ls ON ls.api_key_id=a.id
    WHERE ap.actual_enabled=1 AND ap.published_system_name!=''
      AND (ls.mx IS NULL OR (julianday('now')-julianday(ls.mx))*1440 > ${STALE_MIN});
  " 2>/dev/null || echo 0)
  if [[ "${stale:-0}" -gt 0 ]]; then
    alerts+=("${stale} enabled client(s) with snapshot older than ${STALE_MIN}m")
    if [[ "${RESTART_ON_STALE}" == "1" ]]; then
      restart_unit btdd-runtime
    fi
  fi
fi

# Opportunistic RAM reclaim (orphan hybrid/sweep node leftovers). Never touches btdd-*.
RAM_CLEANUP="${APP_DIR}/scripts/vps_ram_cleanup.sh"
if [[ -f "$RAM_CLEANUP" ]]; then
  bash "$RAM_CLEANUP" || log "ram-cleanup exited $?"
fi

if [[ ${#alerts[@]} -gt 0 ]]; then
  notify "🚨 <b>BTDD watchdog</b>%0A$(printf '%s%0A' "${alerts[@]}")"
else
  log "OK"
fi

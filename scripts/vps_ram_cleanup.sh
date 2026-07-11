#!/usr/bin/env bash
# Kill stale orphan Node processes that leak VPS RAM.
# Never touches systemd BTDD services (api / runtime / research).
#
# Install (root crontab, every 15m):
#   */15 * * * * bash /opt/battletoads-double-dragon/scripts/vps_ram_cleanup.sh >>/var/log/btdd-ram-cleanup.log 2>&1
#
# Env:
#   DRY_RUN=1              — log only, do not kill
#   HYBRID_SCRIPT_MAX_AGE_SEC=7200   — orphan scripts/hybrid/*.mjs age (default 2h)
#   SWEEP_NODE_MAX_AGE_SEC=43200     — hybridSweepNode/Worker age (default 12h)
#   MIN_AVAIL_MIB=800      — if MemAvailable below this, also drop page caches (root)
set -euo pipefail

APP="${APP_DIR:-/opt/battletoads-double-dragon}"
DRY_RUN="${DRY_RUN:-0}"
HYBRID_SCRIPT_MAX_AGE_SEC="${HYBRID_SCRIPT_MAX_AGE_SEC:-7200}"
SWEEP_NODE_MAX_AGE_SEC="${SWEEP_NODE_MAX_AGE_SEC:-43200}"
MIN_AVAIL_MIB="${MIN_AVAIL_MIB:-800}"
LOG_TAG="[vps-ram-cleanup]"

log() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) $LOG_TAG $*"; }

mem_avail_mib() {
  awk '/^MemAvailable:/ {printf "%d", $2/1024}' /proc/meminfo
}

# PIDs of protected systemd units (never kill these or their direct MainPID trees via cmdline match alone).
declare -A PROTECTED_PIDS=()
protect_unit() {
  local unit="$1" pid
  pid="$(systemctl show -p MainPID --value "$unit" 2>/dev/null || echo 0)"
  if [[ -n "$pid" && "$pid" != "0" ]]; then
    PROTECTED_PIDS["$pid"]=1
  fi
}
protect_unit btdd-api
protect_unit btdd-runtime
protect_unit btdd-research

is_protected_pid() {
  local pid="$1"
  [[ -n "${PROTECTED_PIDS[$pid]+x}" ]] && return 0
  # Walk parents up to PID 1; if any is a protected MainPID, skip.
  local cur="$pid" ppid
  local i=0
  while [[ "$cur" -gt 1 && $i -lt 12 ]]; do
    if [[ -n "${PROTECTED_PIDS[$cur]+x}" ]]; then
      return 0
    fi
    ppid="$(awk '{print $4}' "/proc/$cur/stat" 2>/dev/null || echo 1)"
    [[ -z "$ppid" || "$ppid" == "$cur" ]] && break
    cur="$ppid"
    i=$((i + 1))
  done
  return 1
}

proc_age_sec() {
  local pid="$1"
  local start_ticks hz et_ticks
  start_ticks="$(awk '{print $22}' "/proc/$pid/stat" 2>/dev/null || echo "")"
  [[ -z "$start_ticks" ]] && { echo 0; return; }
  hz="$(getconf CLK_TCK 2>/dev/null || echo 100)"
  # uptime seconds
  local up
  up="$(awk '{print int($1)}' /proc/uptime)"
  et_ticks=$(( up * hz - start_ticks ))
  if (( et_ticks < 0 )); then
    echo 0
  else
    echo $(( et_ticks / hz ))
  fi
}

proc_cmdline() {
  tr '\0' ' ' <"/proc/$1/cmdline" 2>/dev/null | sed 's/[[:space:]]*$//'
}

proc_rss_mib() {
  awk '/^VmRSS:/ {printf "%d", $2/1024}' "/proc/$1/status" 2>/dev/null || echo 0
}

should_kill_orphan() {
  local pid="$1" cmd="$2" age="$3"

  # Always protect core BTDD entrypoints by cmdline.
  case "$cmd" in
    *'/backend/dist/server.js'*|*'/backend/dist/runtime-main.js'*|*'/backend/dist/research-main.js'*)
      return 1
      ;;
  esac

  if is_protected_pid "$pid"; then
    return 1
  fi

  # Stale one-shot hybrid scripts (research/admin left running).
  if [[ "$cmd" == *'/scripts/hybrid/'* ]] || [[ "$cmd" == *' scripts/hybrid/'* ]]; then
    if (( age >= HYBRID_SCRIPT_MAX_AGE_SEC )); then
      return 0
    fi
  fi

  # Distributed / local sweep node left orphaned (often under root, reparented to init).
  if [[ "$cmd" == *'hybridSweepNodeEntry.js'* ]] || [[ "$cmd" == *'hybridSweepWorkerEntry.js'* ]] \
     || [[ "$cmd" == *'hybridSweepLocalEntry'* ]]; then
    if (( age >= SWEEP_NODE_MAX_AGE_SEC )); then
      return 0
    fi
  fi

  # Known long-lived audit/replay helpers that routinely leak.
  if [[ "$cmd" == *'generate_momentum_scalp'* ]] || [[ "$cmd" == *'backfill_review_snapshots'* ]] \
     || [[ "$cmd" == *'hard_stop_inactive_legs'* ]]; then
    if (( age >= HYBRID_SCRIPT_MAX_AGE_SEC )); then
      return 0
    fi
  fi

  return 1
}

killed=0
skipped=0
before_avail="$(mem_avail_mib)"

log "start avail=${before_avail}MiB dry_run=${DRY_RUN} hybrid_age>${HYBRID_SCRIPT_MAX_AGE_SEC}s sweep_age>${SWEEP_NODE_MAX_AGE_SEC}s"

shopt -s nullglob
for proc in /proc/[0-9]*; do
  pid="${proc##*/}"
  [[ -r "$proc/cmdline" ]] || continue
  cmd="$(proc_cmdline "$pid")"
  [[ -z "$cmd" ]] && continue
  # Only consider node processes
  case "$cmd" in
    *node*|*nodejs*) ;;
    *) continue ;;
  esac

  if ! should_kill_orphan "$pid" "$cmd" "$(proc_age_sec "$pid")"; then
    continue
  fi

  age="$(proc_age_sec "$pid")"
  rss="$(proc_rss_mib "$pid")"
  short="${cmd:0:160}"

  if [[ "$DRY_RUN" == "1" ]]; then
    log "DRY_RUN would kill pid=$pid rss=${rss}MiB age=${age}s cmd=$short"
    skipped=$((skipped + 1))
    continue
  fi

  log "killing pid=$pid rss=${rss}MiB age=${age}s cmd=$short"
  kill -TERM "$pid" 2>/dev/null || true
  killed=$((killed + 1))
done

if (( killed > 0 )); then
  sleep 2
  # Force stubborn orphans
  for proc in /proc/[0-9]*; do
    pid="${proc##*/}"
    [[ -r "$proc/cmdline" ]] || continue
    cmd="$(proc_cmdline "$pid")"
    [[ -z "$cmd" ]] && continue
    case "$cmd" in
      *node*|*nodejs*) ;;
      *) continue ;;
    esac
    age="$(proc_age_sec "$pid")"
    if should_kill_orphan "$pid" "$cmd" "$age"; then
      log "SIGKILL pid=$pid age=${age}s"
      kill -KILL "$pid" 2>/dev/null || true
    fi
  done
fi

# Drop page caches only when critically low (safe: does not kill processes).
after_kill_avail="$(mem_avail_mib)"
if (( after_kill_avail < MIN_AVAIL_MIB )) && [[ "$DRY_RUN" != "1" ]] && [[ "$(id -u)" -eq 0 ]]; then
  log "MemAvailable ${after_kill_avail}MiB < ${MIN_AVAIL_MIB}MiB — dropping page caches"
  sync
  echo 1 >/proc/sys/vm/drop_caches 2>/dev/null || true
fi

after_avail="$(mem_avail_mib)"
swap_used="$(awk '/^SwapTotal:/ {t=$2} /^SwapFree:/ {f=$2} END {printf "%d", (t-f)/1024}' /proc/meminfo)"
log "done killed=$killed dry_candidates=$skipped avail ${before_avail}→${after_avail}MiB swap_used=${swap_used}MiB"
free -h | head -2

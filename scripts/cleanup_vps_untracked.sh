#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
DRY_RUN="${DRY_RUN:-1}"
BACKUP_DIR="${BACKUP_DIR:-/root/btdd-cleanup-backups}"

# Untracked paths that are safe to remove on VPS.
SAFE_CLEAN_PATHS=(
  "results"
)

log() {
  echo "[cleanup-vps] $*"
}

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run this script as root (sudo)."
  exit 1
fi

if [[ ! -d "${APP_DIR}/.git" ]]; then
  echo "Repository not found in ${APP_DIR}"
  exit 1
fi

cd "${APP_DIR}"

log "Current status before cleanup"
git status --short --branch

mkdir -p "${BACKUP_DIR}"
TS="$(date +%Y%m%d-%H%M%S)"

for rel in "${SAFE_CLEAN_PATHS[@]}"; do
  if git ls-files --error-unmatch "${rel}" >/dev/null 2>&1; then
    log "Skip tracked path: ${rel}"
    continue
  fi

  if [[ ! -e "${rel}" ]]; then
    log "Not found: ${rel}"
    continue
  fi

  backup_file="${BACKUP_DIR}/${TS}_${rel//\//_}.tar.gz"

  if [[ "${DRY_RUN}" == "1" ]]; then
    log "DRY-RUN: would backup ${rel} to ${backup_file}"
    log "DRY-RUN: would remove ${rel}"
    continue
  fi

  tar -czf "${backup_file}" "${rel}"
  rm -rf "${rel}"
  log "Removed ${rel} (backup: ${backup_file})"
done

log "Status after cleanup"
git status --short --branch

if [[ "${DRY_RUN}" == "1" ]]; then
  log "No files were removed (DRY-RUN=1)."
  log "Apply cleanup: DRY_RUN=0 sudo APP_DIR=${APP_DIR} bash scripts/cleanup_vps_untracked.sh"
fi

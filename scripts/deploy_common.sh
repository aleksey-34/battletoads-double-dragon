#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

MODE="${1:-}"
SSH_HOST_DEFAULT="root@176.57.184.98"
APP_DIR_DEFAULT="/opt/battletoads-double-dragon"

usage() {
  cat <<'EOF'
Unified deploy wrapper.

Usage:
  bash scripts/deploy_common.sh <mode> [args...]

Modes:
  local [ssh_host] [branch] [app_dir]
    - Run from local machine
    - Push current branch and deploy via git on VPS
    - Wraps: scripts/deploy_vps_git_branch.sh

  local-tree [ssh_host] [app_dir]
    - Run from local machine
    - Deploy current local tree (including uncommitted changes) via rsync
    - Wraps: scripts/deploy_vps_current_tree.sh

  vps [branch] [app_dir]
    - Run directly on VPS (as root/sudo)
    - Pull/build/restart from git
    - Wraps: scripts/update_vps_from_git.sh

Examples:
  bash scripts/deploy_common.sh local
  bash scripts/deploy_common.sh local root@176.57.184.98 feature/tv-engine-refactor
  bash scripts/deploy_common.sh local-tree root@176.57.184.98
  sudo bash scripts/deploy_common.sh vps feature/tv-engine-refactor
EOF
}

log() {
  echo "[deploy-common] $*"
}

if [[ -z "${MODE}" || "${MODE}" == "-h" || "${MODE}" == "--help" ]]; then
  usage
  exit 0
fi

case "${MODE}" in
  local)
    SSH_HOST="${2:-${SSH_HOST_DEFAULT}}"
    BRANCH="${3:-$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD)}"
    APP_DIR="${4:-${APP_DIR_DEFAULT}}"

    log "Mode local: ${SSH_HOST} branch=${BRANCH} app_dir=${APP_DIR}"
    bash "${SCRIPT_DIR}/deploy_vps_git_branch.sh" "${SSH_HOST}" "${BRANCH}" "${APP_DIR}"
    ;;

  local-tree)
    SSH_HOST="${2:-${SSH_HOST_DEFAULT}}"
    APP_DIR="${3:-${APP_DIR_DEFAULT}}"

    log "Mode local-tree: ${SSH_HOST} app_dir=${APP_DIR}"
    bash "${SCRIPT_DIR}/deploy_vps_current_tree.sh" "${SSH_HOST}" "${APP_DIR}"
    ;;

  vps)
    BRANCH="${2:-main}"
    APP_DIR="${3:-${APP_DIR_DEFAULT}}"

    if [[ "$(id -u)" -ne 0 ]]; then
      echo "Mode vps must be run as root (use sudo)."
      exit 1
    fi

    log "Mode vps: branch=${BRANCH} app_dir=${APP_DIR}"
    APP_DIR="${APP_DIR}" BRANCH="${BRANCH}" bash "${SCRIPT_DIR}/update_vps_from_git.sh"
    ;;

  *)
    echo "Unknown mode: ${MODE}"
    usage
    exit 1
    ;;
esac

log "Done"

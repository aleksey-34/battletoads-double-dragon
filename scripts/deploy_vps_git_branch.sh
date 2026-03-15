#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SSH_HOST="${1:-root@176.57.184.98}"
BRANCH="${2:-$(git -C "${ROOT_DIR}" rev-parse --abbrev-ref HEAD)}"
APP_DIR="${3:-/opt/battletoads-double-dragon}"

SSH_OPTS="${SSH_OPTS:-}"
SKIP_PUSH="${SKIP_PUSH:-0}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy_vps_git_branch.sh [ssh_host] [branch] [app_dir]

Examples:
  bash scripts/deploy_vps_git_branch.sh
  bash scripts/deploy_vps_git_branch.sh root@176.57.184.98 feature/tv-engine-refactor
  SSH_OPTS='-i ~/.ssh/id_rsa -p 22' bash scripts/deploy_vps_git_branch.sh root@176.57.184.98 feature/tv-engine-refactor /opt/battletoads-double-dragon

Env vars:
  SSH_OPTS   additional ssh options
  SKIP_PUSH  set to 1 to skip local git push step
EOF
}

log() {
  echo "[deploy-vps-git] $*"
}

if [[ "${SSH_HOST}" == "-h" || "${SSH_HOST}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ -z "${SSH_HOST}" || -z "${BRANCH}" || -z "${APP_DIR}" ]]; then
  usage
  exit 1
fi

if [[ "${SKIP_PUSH}" != "1" ]]; then
  if [[ -n "$(git -C "${ROOT_DIR}" status --porcelain)" ]]; then
    echo "Local working tree has uncommitted changes."
    echo "Commit them first, or run with SKIP_PUSH=1 if you know what you are doing."
    echo "Alternative for uncommitted deploy: bash scripts/deploy_vps_current_tree.sh <ssh_host>"
    exit 1
  fi

  log "Pushing branch ${BRANCH} to origin"
  git -C "${ROOT_DIR}" push origin "${BRANCH}"
fi

REMOTE_CMD=$(cat <<EOF
set -euo pipefail

if [[ ! -d '${APP_DIR}/.git' ]]; then
  echo 'Repository not found in ${APP_DIR}'
  exit 1
fi

git -C '${APP_DIR}' config remote.origin.fetch '+refs/heads/*:refs/remotes/origin/*'
GIT_TERMINAL_PROMPT=0 git -C '${APP_DIR}' fetch --prune origin '+refs/heads/*:refs/remotes/origin/*'

APP_DIR='${APP_DIR}' BRANCH='${BRANCH}' bash '${APP_DIR}/scripts/update_vps_from_git.sh'

echo
systemctl status battletoads-backend.service --no-pager | head -n 30
echo
systemctl status nginx --no-pager | head -n 20
EOF
)

log "Deploying ${BRANCH} to ${SSH_HOST}:${APP_DIR}"
# shellcheck disable=SC2086
ssh ${SSH_OPTS} "${SSH_HOST}" "${REMOTE_CMD}"

log "Deployment complete"

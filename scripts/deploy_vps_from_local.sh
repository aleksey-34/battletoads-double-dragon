#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

SSH_HOST="${1:-}"
REPO_URL="${2:-}"
DOMAIN="${3:-_}"
BRANCH="${4:-main}"
APP_DIR="${5:-/opt/battletoads-double-dragon}"

SSH_OPTS="${SSH_OPTS:-}"
ADMIN_PASSWORD="${ADMIN_PASSWORD:-}"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/deploy_vps_from_local.sh <ssh_host> <repo_url> [domain] [branch] [app_dir]

Examples:
  bash scripts/deploy_vps_from_local.sh root@45.94.23.184 https://github.com/owner/repo.git
  ADMIN_PASSWORD='StrongPass123!' bash scripts/deploy_vps_from_local.sh root@45.94.23.184 https://github.com/owner/repo.git bot.example.com main /opt/battletoads-double-dragon

Optional env vars:
  SSH_OPTS        e.g. "-i ~/.ssh/id_rsa -p 22"
  ADMIN_PASSWORD  backend auth password (if empty, setup script generates random one)
EOF
}

if [[ -z "${SSH_HOST}" || -z "${REPO_URL}" ]]; then
  usage
  exit 1
fi

log() {
  echo "[deploy-local] $*"
}

cd "${ROOT_DIR}"

log "Building deployment bundle"
bash "${SCRIPT_DIR}/build_vps_package.sh"

LATEST_BUNDLE="$(ls -1t "${SCRIPT_DIR}"/dist/btdd_vps_git_bundle_*.tar.gz | head -n 1)"
if [[ -z "${LATEST_BUNDLE}" || ! -f "${LATEST_BUNDLE}" ]]; then
  echo "Bundle not found in ${SCRIPT_DIR}/dist"
  exit 1
fi

BUNDLE_BASENAME="$(basename "${LATEST_BUNDLE}")"
BUNDLE_DIR_NAME="${BUNDLE_BASENAME%.tar.gz}"

log "Uploading ${BUNDLE_BASENAME} to ${SSH_HOST}:/root/"
# shellcheck disable=SC2086
scp ${SSH_OPTS} "${LATEST_BUNDLE}" "${SSH_HOST}:/root/"

log "Running remote setup on ${SSH_HOST}"

REMOTE_CMD=$(cat <<EOF
set -euo pipefail
cd /root
test -f "${BUNDLE_BASENAME}"
tar -xzf "${BUNDLE_BASENAME}"
cd "${BUNDLE_DIR_NAME}"
DOMAIN='${DOMAIN}' ADMIN_PASSWORD='${ADMIN_PASSWORD}' bash setup_vps_ubuntu20.sh '${REPO_URL}' '${APP_DIR}' '${BRANCH}'
EOF
)

# shellcheck disable=SC2086
ssh ${SSH_OPTS} "${SSH_HOST}" "${REMOTE_CMD}"

log "Deployment finished"
echo ""
echo "Next checks on VPS:"
echo "  ssh ${SSH_HOST} \"systemctl status battletoads-backend --no-pager\""
echo "  ssh ${SSH_HOST} \"systemctl status nginx --no-pager\""

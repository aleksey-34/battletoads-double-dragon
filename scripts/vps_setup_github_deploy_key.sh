#!/usr/bin/env bash
# Configure read-only GitHub deploy key for ubuntu user on VPS.
set -euo pipefail

DEPLOY_USER="${DEPLOY_USER:-ubuntu}"
KEY_PATH="${KEY_PATH:-/home/${DEPLOY_USER}/.ssh/id_ed25519_btdd_deploy}"
REPO="${REPO:-git@github.com:aleksey-34/battletoads-double-dragon.git}"
APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"

log() { printf '[vps-github] %s\n' "$*"; }

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run as root"
  exit 1
fi

install -d -m 700 -o "$DEPLOY_USER" -g "$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh"

if [[ ! -f "$KEY_PATH" ]]; then
  log "Generating deploy key at $KEY_PATH"
  sudo -u "$DEPLOY_USER" ssh-keygen -t ed25519 -f "$KEY_PATH" -N "" -C "btdd-vps-deploy-$(hostname -s)"
fi

ssh-keyscan -t ed25519,rsa github.com >> "/home/${DEPLOY_USER}/.ssh/known_hosts" 2>/dev/null || true
sort -u "/home/${DEPLOY_USER}/.ssh/known_hosts" -o "/home/${DEPLOY_USER}/.ssh/known_hosts"
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/known_hosts"
chmod 600 "/home/${DEPLOY_USER}/.ssh/known_hosts"

cat > "/home/${DEPLOY_USER}/.ssh/config" <<EOF
Host github.com
  HostName github.com
  User git
  IdentityFile ${KEY_PATH}
  IdentitiesOnly yes
EOF
chown "$DEPLOY_USER:$DEPLOY_USER" "/home/${DEPLOY_USER}/.ssh/config"
chmod 600 "/home/${DEPLOY_USER}/.ssh/config"

if [[ -d "$APP_DIR/.git" ]]; then
  sudo -u "$DEPLOY_USER" git -C "$APP_DIR" remote set-url origin "$REPO"
fi

PUB="$(cat "${KEY_PATH}.pub")"
log "Deploy public key (add at GitHub → repo → Settings → Deploy keys, read-only):"
echo "$PUB"
echo
log "After adding the key, test:"
echo "  sudo -u ${DEPLOY_USER} git -C ${APP_DIR} fetch origin main"
echo "  sudo DEPLOY_MODE=multi bash ${APP_DIR}/scripts/update_vps_from_git.sh"

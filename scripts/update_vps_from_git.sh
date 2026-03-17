#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BRANCH="${BRANCH:-main}"
SERVICE_NAME="${SERVICE_NAME:-battletoads-backend}"
BACKEND_DIR="${BACKEND_DIR:-$APP_DIR/backend}"

log() {
	printf '[btdd-update] %s\n' "$*"
}

fail() {
	log "ERROR: $*"
	exit 1
}

run() {
	log "+ $*"
	"$@"
}

require_cmd() {
	command -v "$1" >/dev/null 2>&1 || fail "Required command not found: $1"
}

require_cmd git
require_cmd npm
require_cmd systemctl

[[ -d "$APP_DIR/.git" ]] || fail "Not a git repository: $APP_DIR"
[[ -d "$BACKEND_DIR" ]] || fail "Backend directory not found: $BACKEND_DIR"

cd "$APP_DIR"

local_head="$(git rev-parse --short HEAD)"
log "Starting deploy in $APP_DIR"
log "Local HEAD before update: $local_head"

run git fetch --prune origin

dirty_count="$(git status --porcelain | wc -l | tr -d ' ')"
if [[ "$dirty_count" != "0" ]]; then
	fail "Repository has local changes ($dirty_count). Refusing to deploy."
fi

run git checkout "$BRANCH"
run git reset --hard "origin/$BRANCH"

local_head_after="$(git rev-parse --short HEAD)"
log "Local HEAD after update: $local_head_after"

cd "$BACKEND_DIR"

run npm ci --silent
run npm run build

run systemctl restart "$SERVICE_NAME"
service_state="$(systemctl is-active "$SERVICE_NAME" || true)"
[[ "$service_state" == "active" ]] || fail "Service $SERVICE_NAME is not active after restart"

log "Service $SERVICE_NAME state: $service_state"
log "Deploy finished successfully"

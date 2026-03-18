#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BRANCH="${BRANCH:-main}"
# Режим деплоя: single (старый единый сервис) | multi (три отдельных сервиса)
DEPLOY_MODE="${DEPLOY_MODE:-single}"
SERVICE_NAME="${SERVICE_NAME:-battletoads-backend}"
BACKEND_DIR="${BACKEND_DIR:-$APP_DIR/backend}"
FRONTEND_DIR="${FRONTEND_DIR:-$APP_DIR/frontend}"
BUILD_FRONTEND="${BUILD_FRONTEND:-1}"

# В multi-режиме рестартуем эти три сервиса
MULTI_SERVICES="${MULTI_SERVICES:-btdd-api btdd-runtime btdd-research}"
# Какие сервисы перезапускать при деплое API (runtime обычно не трогаем)
# Установите RESTART_RUNTIME=0 чтобы не перезапускать торговый контур при обновлении API
RESTART_RUNTIME="${RESTART_RUNTIME:-1}"

log() {
	printf '[btdd-update] %s\n' "$*"
}

fail() {
	log "ERROR: $*"
	exit 1
}

# NOTE: Keep this script deterministic for one-click VPS deploys from Settings.

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
if [[ "$BUILD_FRONTEND" == "1" ]]; then
	[[ -d "$FRONTEND_DIR" ]] || fail "Frontend directory not found: $FRONTEND_DIR"
fi

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

if [[ "$BUILD_FRONTEND" == "1" ]]; then
	cd "$FRONTEND_DIR"
	run npm ci --silent
	# CRA treats warnings as errors when CI=true; force production build without CI strict mode on VPS deploy.
	run env CI=false npm run build
fi

# ── Рестарт сервисов ──────────────────────────────────────────────────────────
if [[ "$DEPLOY_MODE" == "multi" ]]; then
	log "Multi-service mode: перезапуск трёх сервисов"
	for svc in $MULTI_SERVICES; do
		if [[ "$svc" == "btdd-runtime" && "$RESTART_RUNTIME" == "0" ]]; then
			log "Пропускаем перезапуск $svc (RESTART_RUNTIME=0)"
			continue
		fi
		if systemctl is-enabled --quiet "$svc" 2>/dev/null; then
			run systemctl restart "$svc"
			state="$(systemctl is-active "$svc" || true)"
			[[ "$state" == "active" ]] || fail "Service $svc is not active after restart (state: $state)"
			log "Service $svc state: $state"
		else
			log "WARN: $svc не включён, пропускаем"
		fi
	done
else
	# Обратная совместимость: одиночный сервис (старый режим)
	run systemctl restart "$SERVICE_NAME"
	service_state="$(systemctl is-active "$SERVICE_NAME" || true)"
	[[ "$service_state" == "active" ]] || fail "Service $SERVICE_NAME is not active after restart"
	log "Service $SERVICE_NAME state: $service_state"
fi

log "Deploy finished successfully"


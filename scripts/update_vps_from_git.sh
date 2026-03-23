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
# 1 => после frontend build синхронизировать артефакты в nginx root и reload nginx.
# Важно для VPS-контура, где nginx отдает статику напрямую и может оставаться старый UI.
SYNC_FRONTEND_NGINX="${SYNC_FRONTEND_NGINX:-1}"

# В multi-режиме рестартуем эти три сервиса
MULTI_SERVICES="${MULTI_SERVICES:-btdd-api btdd-runtime btdd-research}"
# Какие сервисы перезапускать при деплое API (runtime обычно не трогаем)
# Установите RESTART_RUNTIME=0 чтобы не перезапускать торговый контур при обновлении API
RESTART_RUNTIME="${RESTART_RUNTIME:-1}"
# 1 => не блокировать деплой при изменениях tracked-файлов и принудительно
# выбросить локальные правки через git reset --hard origin/<branch>.
ALLOW_DIRTY_TRACKED="${ALLOW_DIRTY_TRACKED:-0}"

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

install_node_deps() {
	local target_dir="$1"
	cd "$target_dir"
	if npm ci --silent; then
		log "Dependencies installed with npm ci in $target_dir"
		return 0
	fi
	log "WARN: npm ci failed in $target_dir, falling back to npm install"
	run npm install --no-audit --no-fund --silent
}

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

# Игнорируем untracked runtime-файлы (например backend/.auth-password.json, data/*),
# но блокируем деплой при изменениях tracked-файлов.
dirty_list="$(git status --porcelain --untracked-files=no)"
dirty_count="$(echo -n "$dirty_list" | wc -l | tr -d ' ')"
if [[ "$dirty_count" != "0" ]]; then
	if [[ "$ALLOW_DIRTY_TRACKED" == "1" ]]; then
		log "WARN: Repository has local tracked changes ($dirty_count). Proceeding because ALLOW_DIRTY_TRACKED=1."
		log "Dirty files:"
		echo "$dirty_list" | while IFS= read -r line; do log "  $line"; done
	else
		log "Dirty files that blocked deploy:"
		echo "$dirty_list" | while IFS= read -r line; do log "  $line"; done
		fail "Repository has $dirty_count local tracked change(s). Set ALLOW_DIRTY_TRACKED=1 to force."
	fi
fi

run git checkout "$BRANCH"
run git reset --hard "origin/$BRANCH"

local_head_after="$(git rev-parse --short HEAD)"
log "Local HEAD after update: $local_head_after"

cd "$BACKEND_DIR"

install_node_deps "$BACKEND_DIR"
run npm run build

if [[ "$BUILD_FRONTEND" == "1" ]]; then
	cd "$FRONTEND_DIR"
	install_node_deps "$FRONTEND_DIR"
	# CRA treats warnings as errors when CI=true; force production build without CI strict mode on VPS deploy.
	run env CI=false npm run build

	if [[ "$SYNC_FRONTEND_NGINX" == "1" ]]; then
		if command -v nginx >/dev/null 2>&1; then
			# Sync into all configured nginx roots to avoid stale UI when active vhost
			# is not the first `root` directive in nginx -T output.
			mapfile -t NGINX_ROOTS < <(nginx -T 2>&1 \
				| awk '$1=="root"{gsub(";", "", $2); if($2 ~ /^\//) print $2}' \
				| sort -u)

			SYNCED=0
			for NGINX_ROOT in "${NGINX_ROOTS[@]:-}"; do
				if [[ -z "$NGINX_ROOT" || ! -d "$NGINX_ROOT" ]]; then
					continue
				fi

				if command -v rsync >/dev/null 2>&1; then
					run rsync -a --delete "$FRONTEND_DIR/build/" "$NGINX_ROOT/"
				else
					log "WARN: rsync not found, fallback to cp -a for nginx sync"
					run rm -rf "$NGINX_ROOT"/*
					run cp -a "$FRONTEND_DIR/build/." "$NGINX_ROOT/"
				fi
				log "Frontend synced to nginx root: $NGINX_ROOT"
				SYNCED=1
			done

			if [[ "$SYNCED" == "1" ]]; then
				run systemctl reload nginx
			else
				log "WARN: nginx roots not detected or not accessible, skip frontend sync"
			fi
		else
			log "WARN: nginx is not installed, skip frontend sync"
		fi
	fi
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


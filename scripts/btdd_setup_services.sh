#!/usr/bin/env bash
#
# btdd_setup_services.sh — Установка и первичная настройка трёх BTDD systemd-сервисов.
#
# Запускается ОДИН РАЗ на чистом VPS после деплоя. Далее используется только
# update_vps_from_git.sh для обновлений.
#
# Использование:
#   sudo bash scripts/btdd_setup_services.sh
#
# Требования:
#   - Ubuntu 20.04 / 22.04
#   - Node.js 18+ установлен в /usr/bin/node
#   - Код задеплоен в /opt/battletoads-double-dragon
#   - Файл /opt/battletoads-double-dragon/.env существует и заполнен
#
set -euo pipefail

APP_DIR="${APP_DIR:-/opt/battletoads-double-dragon}"
BACKEND_DIR="$APP_DIR/backend"
SYSTEMD_DIR="/etc/systemd/system"
SCRIPTS_SYSTEMD_DIR="$APP_DIR/scripts/systemd"
DATA_DIR="${DATA_DIR:-$APP_DIR/data}"

log() { printf '[btdd-setup] %s\n' "$*"; }
fail() { log "ERROR: $*"; exit 1; }

[[ "$(id -u)" -eq 0 ]] || fail "Запустите с sudo"
[[ -d "$APP_DIR/.git" ]] || fail "Репозиторий не найден: $APP_DIR"
[[ -f "$APP_DIR/.env" ]] || fail ".env не найден: $APP_DIR/.env"
command -v node >/dev/null 2>&1 || fail "Node.js не установлен"

NODE_BIN="$(command -v node)"
DEFAULT_SERVICE_USER="${SUDO_USER:-$(id -un)}"
SERVICE_USER="${SERVICE_USER:-$DEFAULT_SERVICE_USER}"
id "$SERVICE_USER" >/dev/null 2>&1 || fail "Пользователь не найден: $SERVICE_USER"
SERVICE_GROUP="$(id -gn "$SERVICE_USER")"

log "Node.js: $NODE_BIN ($(node --version))"
log "Service user/group: $SERVICE_USER:$SERVICE_GROUP"

# ── Директория для данных БД ──────────────────────────────────────────────────
if [[ ! -d "$DATA_DIR" ]]; then
    log "Создаём $DATA_DIR"
    mkdir -p "$DATA_DIR"
fi
chown "$SERVICE_USER:$SERVICE_GROUP" "$DATA_DIR"

# ── Сборка backend ────────────────────────────────────────────────────────────
log "Сборка backend..."
cd "$BACKEND_DIR"
npm ci --silent
npm run build
log "Backend собран: $BACKEND_DIR/dist/"

# ── Проверяем нужные entry points ─────────────────────────────────────────────
for f in server.js runtime-main.js research-main.js; do
    [[ -f "$BACKEND_DIR/dist/$f" ]] || fail "Не найден: $BACKEND_DIR/dist/$f — проверьте сборку"
done
log "Entry points проверены: server.js, runtime-main.js, research-main.js"

# ── Остановить старый сервис если есть ───────────────────────────────────────
OLD_SERVICE="battletoads-backend"
if systemctl is-active --quiet "$OLD_SERVICE" 2>/dev/null; then
    log "Останавливаем старый сервис $OLD_SERVICE..."
    systemctl stop "$OLD_SERVICE" || true
    systemctl disable "$OLD_SERVICE" || true
fi

# ── Установка unit-файлов ─────────────────────────────────────────────────────
for svc in btdd-api btdd-runtime btdd-research; do
    src="$SCRIPTS_SYSTEMD_DIR/${svc}.service"
    dst="$SYSTEMD_DIR/${svc}.service"
    [[ -f "$src" ]] || fail "Unit-файл не найден: $src"
    cp "$src" "$dst"
    # Подставляем реальный путь к node если отличается
    sed -i "s|/usr/bin/node|$NODE_BIN|g" "$dst"
    sed -i "s|^User=.*$|User=$SERVICE_USER|" "$dst"
    sed -i "s|^Group=.*$|Group=$SERVICE_GROUP|" "$dst"
    log "Установлен: $dst"
done

systemctl daemon-reload

# ── Включить и запустить ──────────────────────────────────────────────────────
for svc in btdd-api btdd-runtime btdd-research; do
    systemctl enable "$svc"
    systemctl start "$svc"
    sleep 2
    state="$(systemctl is-active "$svc" || true)"
    if [[ "$state" == "active" ]]; then
        log "✓ $svc: active"
    else
        log "WARN: $svc state = $state (проверьте: journalctl -u $svc -n 50)"
    fi
done

log ""
log "═══════════════════════════════════════════"
log "Установка завершена. Три сервиса запущены:"
log "  btdd-api      — HTTP API + frontend serve"
log "  btdd-runtime  — торговый контур"
log "  btdd-research — research workers"
log ""
log "Полезные команды:"
log "  journalctl -u btdd-api -f"
log "  journalctl -u btdd-runtime -f"
log "  journalctl -u btdd-research -f"
log "  systemctl status btdd-api btdd-runtime btdd-research"
log "═══════════════════════════════════════════"

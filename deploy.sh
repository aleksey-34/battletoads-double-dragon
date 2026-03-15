#!/usr/bin/env bash
set -euo pipefail

# Guard against sourcing this script in an interactive shell.
if [[ "${BASH_SOURCE[0]}" != "$0" ]]; then
  echo "Do not source deploy.sh. Run it as a command:"
  echo "  bash /opt/battletoads-double-dragon/deploy.sh vps <branch> /opt/battletoads-double-dragon"
  return 1 2>/dev/null || exit 1
fi

resolve_self_path() {
  local source="${BASH_SOURCE[0]}"
  while [[ -h "${source}" ]]; do
    local dir
    dir="$(cd -P "$(dirname "${source}")" >/dev/null 2>&1 && pwd)"
    source="$(readlink "${source}")"
    if [[ "${source}" != /* ]]; then
      source="${dir}/${source}"
    fi
  done
  (
    cd -P "$(dirname "${source}")" >/dev/null 2>&1 && pwd
  )
}

ROOT_DIR="$(resolve_self_path)"
COMMON_SCRIPT="${ROOT_DIR}/scripts/deploy_common.sh"

usage() {
  cat <<'EOF'
BattleToads unified deploy launcher.

Usage:
  bash /opt/battletoads-double-dragon/deploy.sh <mode> [args...]

Modes:
  local [ssh_host] [branch] [app_dir]
  local-tree [ssh_host] [app_dir]
  vps [branch] [app_dir]
  install-bin

Examples:
  bash ./deploy.sh local
  sudo bash /opt/battletoads-double-dragon/deploy.sh vps feature/tv-engine-refactor /opt/battletoads-double-dragon
  sudo bash /opt/battletoads-double-dragon/deploy.sh install-bin

After install-bin you can run from anywhere:
  sudo btdd-deploy vps feature/tv-engine-refactor /opt/battletoads-double-dragon
EOF
}

if [[ ! -f "${COMMON_SCRIPT}" ]]; then
  echo "Cannot find ${COMMON_SCRIPT}"
  echo "Run this script from repository root, or use full path to deployed repo on VPS."
  exit 1
fi

MODE="${1:-}"
if [[ -z "${MODE}" || "${MODE}" == "-h" || "${MODE}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${MODE}" == "install-bin" ]]; then
  if [[ "$(id -u)" -ne 0 ]]; then
    echo "Run install-bin as root: sudo bash /opt/battletoads-double-dragon/deploy.sh install-bin"
    exit 1
  fi

  ln -sf "${ROOT_DIR}/deploy.sh" /usr/local/bin/btdd-deploy
  chmod +x /usr/local/bin/btdd-deploy
  echo "Installed: /usr/local/bin/btdd-deploy -> ${ROOT_DIR}/deploy.sh"
  echo "Now run: sudo btdd-deploy vps feature/tv-engine-refactor /opt/battletoads-double-dragon"
  exit 0
fi

bash "${COMMON_SCRIPT}" "$@"

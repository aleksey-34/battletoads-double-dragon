#!/usr/bin/env bash
set -euo pipefail

REPO_NAME="${1:-battletoads-double-dragon}"
VISIBILITY="${2:-private}"
BRANCH="${3:-main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/create_github_repo.sh [repo_name] [private|public] [branch]

Examples:
  bash scripts/create_github_repo.sh battletoads-double-dragon private main
  bash scripts/create_github_repo.sh btdd-release public main
EOF
}

if [[ "${REPO_NAME}" == "-h" || "${REPO_NAME}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ "${VISIBILITY}" != "private" && "${VISIBILITY}" != "public" ]]; then
  echo "Visibility must be 'private' or 'public'"
  exit 1
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "GitHub CLI (gh) is not installed. Install it first: sudo apt install gh"
  exit 1
fi

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login"
  exit 1
fi

OWNER="$(gh api user --jq '.login')"
if [[ -z "${OWNER}" ]]; then
  echo "Cannot determine GitHub account login"
  exit 1
fi

REPO_URL="https://github.com/${OWNER}/${REPO_NAME}.git"

# Create repo if not exists
if gh repo view "${OWNER}/${REPO_NAME}" >/dev/null 2>&1; then
  echo "Repository already exists: ${REPO_URL}"
else
  if [[ "${VISIBILITY}" == "private" ]]; then
    gh repo create "${OWNER}/${REPO_NAME}" --private --description "BattleToads Double Dragon" --confirm
  else
    gh repo create "${OWNER}/${REPO_NAME}" --public --description "BattleToads Double Dragon" --confirm
  fi
fi

cd "${ROOT_DIR}"
bash "${SCRIPT_DIR}/bootstrap_git_repo.sh" "${REPO_URL}" "${BRANCH}"

echo "Done: ${REPO_URL}"

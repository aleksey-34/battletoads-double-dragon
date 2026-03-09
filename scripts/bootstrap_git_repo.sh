#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${1:-}"
BRANCH="${2:-main}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"

usage() {
  cat <<'EOF'
Usage:
  bash scripts/bootstrap_git_repo.sh <repo_url> [branch]

Example:
  bash scripts/bootstrap_git_repo.sh https://github.com/YOUR_USER/YOUR_REPO.git main
EOF
}

if [[ -z "${REPO_URL}" ]]; then
  usage
  exit 1
fi

if [[ "${REPO_URL}" == *"<"* || "${REPO_URL}" == *">"* || "${REPO_URL}" == *"YOUR_USER"* || "${REPO_URL}" == *"YOUR_REPO"* ]]; then
  echo "Invalid REPO_URL. Use real URL without placeholders, e.g. https://github.com/user/repo.git"
  exit 1
fi

cd "${ROOT_DIR}"

USER_NAME="$(git config user.name || git config --global user.name || true)"
USER_EMAIL="$(git config user.email || git config --global user.email || true)"

if [[ -z "${USER_NAME}" || -z "${USER_EMAIL}" ]]; then
  echo "Git user is not configured. Run:"
  echo "  git config --global user.name 'Your Name'"
  echo "  git config --global user.email 'you@example.com'"
  exit 1
fi

if [[ ! -d .git ]]; then
  git init
fi

# Create initial commit if repository has no commits yet.
if ! git rev-parse --verify HEAD >/dev/null 2>&1; then
  git add -A
  git commit -m "chore: initial verified release"
else
  # Commit current changes if any.
  if [[ -n "$(git status --porcelain)" ]]; then
    git add -A
    git commit -m "chore: sync verified state"
  fi
fi

if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "${REPO_URL}"
else
  git remote add origin "${REPO_URL}"
fi

git branch -M "${BRANCH}"
git push -u origin "${BRANCH}"

echo "Git repository configured and pushed: ${REPO_URL} (${BRANCH})"

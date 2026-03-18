#!/usr/bin/env bash
set -euo pipefail

# Root wrapper so legacy command works from repo root:
#   bash update_vps_from_git.sh
# It forwards all args/env to scripts/update_vps_from_git.sh.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TARGET="$SCRIPT_DIR/scripts/update_vps_from_git.sh"

if [[ ! -f "$TARGET" ]]; then
  echo "ERROR: target script not found: $TARGET" >&2
  exit 1
fi

exec bash "$TARGET" "$@"

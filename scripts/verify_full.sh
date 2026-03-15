#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

log() {
  echo "[verify-full] $*"
}

log "Building backend"
cd "${ROOT_DIR}/backend"
npm run build

log "Running frontend tests"
cd "${ROOT_DIR}/frontend"
CI=true npm test -- --watchAll=false

log "Building frontend"
npm run build

log "All checks passed"
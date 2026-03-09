#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
OUT_DIR="${1:-${SCRIPT_DIR}/dist}"
TIMESTAMP="$(date -u +%Y%m%d_%H%M%S)"
BUNDLE_NAME="btdd_vps_git_bundle_${TIMESTAMP}"
WORK_DIR="${OUT_DIR}/${BUNDLE_NAME}"
ARCHIVE_PATH="${OUT_DIR}/${BUNDLE_NAME}.tar.gz"

mkdir -p "${WORK_DIR}"

cp "${SCRIPT_DIR}/setup_vps_ubuntu20.sh" "${WORK_DIR}/"
cp "${SCRIPT_DIR}/update_vps_from_git.sh" "${WORK_DIR}/"
cp "${SCRIPT_DIR}/VPS_UBUNTU20.md" "${WORK_DIR}/"

cat > "${WORK_DIR}/README_QUICKSTART.txt" <<'EOF'
BattleToads Double Dragon VPS package (Ubuntu 20.04)

1) Upload this archive to VPS and unpack:
   tar -xzf btdd_vps_git_bundle_*.tar.gz

2) Run initial setup from repository URL:
   sudo DOMAIN=your.domain.com ADMIN_PASSWORD='strong-password' \
     bash setup_vps_ubuntu20.sh https://github.com/owner/repo.git /opt/battletoads-double-dragon main

3) Update later from Git:
   sudo APP_DIR=/opt/battletoads-double-dragon BRANCH=main bash update_vps_from_git.sh

4) Check services:
   sudo systemctl status battletoads-backend
   sudo systemctl status nginx

Detailed docs: VPS_UBUNTU20.md
EOF

chmod +x "${WORK_DIR}/setup_vps_ubuntu20.sh" "${WORK_DIR}/update_vps_from_git.sh"

tar -czf "${ARCHIVE_PATH}" -C "${OUT_DIR}" "${BUNDLE_NAME}"
rm -rf "${WORK_DIR}"

echo "Created package: ${ARCHIVE_PATH}"

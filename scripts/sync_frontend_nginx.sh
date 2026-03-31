#!/usr/bin/env bash
set -euo pipefail
SRC=/opt/battletoads-double-dragon/frontend/build
DST=/var/www/battletoads-double-dragon
rsync -a --delete "$SRC/" "$DST/"
find "$DST" -type d -exec chmod 755 {} +
find "$DST" -type f -exec chmod 644 {} +
systemctl reload nginx
NEW_BUNDLE=$(ls "$DST/static/js/main."*.js 2>/dev/null | head -1 | xargs basename)
echo "SYNC_OK bundle=$NEW_BUNDLE"

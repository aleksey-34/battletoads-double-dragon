#!/usr/bin/env bash
set -euo pipefail

cd /opt/battletoads-double-dragon/frontend
npm run build > /tmp/btdd_front_build.log 2>&1
tail -n 20 /tmp/btdd_front_build.log

rm -rf /var/www/battletoads-double-dragon/*
cp -r build/* /var/www/battletoads-double-dragon/

head -20 /var/www/battletoads-double-dragon/asset-manifest.json
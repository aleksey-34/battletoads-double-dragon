#!/bin/bash
# Rebuild frontend in background, then deploy to nginx
cd /opt/battletoads-double-dragon/frontend
echo "$(date): Starting build..." > /tmp/btdd_front_build.log
npm run build >> /tmp/btdd_front_build.log 2>&1
echo "$(date): Build done, copying..." >> /tmp/btdd_front_build.log
cp -r build/* /var/www/battletoads-double-dragon/
echo "$(date): Deploy done" >> /tmp/btdd_front_build.log

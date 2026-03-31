#!/usr/bin/env bash
set -euo pipefail

nohup bash /tmp/vps_resume_fix_deploy.sh >/tmp/vps_resume_fix_deploy.log 2>&1 </dev/null &
echo "STARTED"

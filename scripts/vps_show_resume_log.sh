#!/usr/bin/env bash
set -euo pipefail

ls -l /tmp/vps_resume_fix_deploy.log /tmp/vps_resume_fix_deploy.sh /tmp/vps_start_resume_wrapper.sh
echo "----- LOG TAIL -----"
sed -n '1,220p' /tmp/vps_resume_fix_deploy.log

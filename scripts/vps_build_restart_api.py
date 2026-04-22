#!/usr/bin/env python3
import json
import subprocess
from pathlib import Path

backend_dir = Path('/opt/battletoads-double-dragon/backend')
out = {}

out['srcServiceExists'] = (backend_dir / 'src/saas/service.ts').exists()
out['srcMarkerFound'] = False
if out['srcServiceExists']:
    text = (backend_dir / 'src/saas/service.ts').read_text(encoding='utf-8', errors='ignore')
    out['srcMarkerFound'] = 'non-SAAS names' in text or 'keyRows.find((row)' in text

build = subprocess.run(['npm', 'run', 'build'], cwd=str(backend_dir), capture_output=True, text=True)
out['buildCode'] = build.returncode
out['buildStdoutTail'] = '\n'.join((build.stdout or '').splitlines()[-60:])
out['buildStderrTail'] = '\n'.join((build.stderr or '').splitlines()[-60:])

if build.returncode == 0:
    restart = subprocess.run(['systemctl', 'restart', 'btdd-api'], capture_output=True, text=True)
    out['restartCode'] = restart.returncode
    out['restartStdout'] = restart.stdout.strip()
    out['restartStderr'] = restart.stderr.strip()

status = subprocess.run(['systemctl', 'is-active', 'btdd-api'], capture_output=True, text=True)
out['apiActive'] = status.stdout.strip()
out['apiActiveCode'] = status.returncode

# dist marker check
out['distServiceExists'] = (backend_dir / 'dist/saas/service.js').exists()
out['distMarkerFound'] = False
if out['distServiceExists']:
    dtext = (backend_dir / 'dist/saas/service.js').read_text(encoding='utf-8', errors='ignore')
    out['distMarkerFound'] = 'keyRows.find((row)' in dtext or 'saas_materialize_reuse_conflict' in dtext

print(json.dumps(out, ensure_ascii=False, indent=2))

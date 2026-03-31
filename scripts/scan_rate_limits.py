#!/usr/bin/env python3
import os
import re
from pathlib import Path

ROOT = Path('/opt/battletoads-double-dragon/backend/logs')
PATTERN = re.compile(r'100410|frequency limit rule|too many|rate limit|\b429\b', re.IGNORECASE)

if not ROOT.exists():
    print('LOG_DIR_MISSING')
    raise SystemExit(0)

matches = []
for p in ROOT.rglob('*'):
    if not p.is_file():
        continue
    try:
        with p.open('r', encoding='utf-8', errors='ignore') as f:
            for idx, line in enumerate(f, 1):
                if PATTERN.search(line):
                    matches.append((str(p), idx, line.strip()))
    except Exception:
        pass

if not matches:
    print('NO_RATE_LIMIT_MATCHES')
else:
    for item in matches[-80:]:
        print(f"{item[0]}:{item[1]}: {item[2][:300]}")

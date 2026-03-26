#!/usr/bin/env python3
"""Check sweep status."""
import urllib.request
import json

BASE = "http://127.0.0.1:3001"
AUTH = "Bearer SuperSecure2026Admin!"

req = urllib.request.Request(
    BASE + "/api/research/sweeps/full-historical/status",
    headers={"Authorization": AUTH},
    method="GET",
)
with urllib.request.urlopen(req, timeout=15) as r:
    data = json.loads(r.read().decode())
    print(f"Job: {data.get('id')} | Mode: {data.get('mode')} | Status: {data.get('status')}")
    print(f"Progress: {data.get('progress_percent')}% | processed: {data.get('processed_days')}/{data.get('analyzed_days')} | ETA: {data.get('eta_seconds')}s")
    if data.get('current_day_key'):
        print(f"Current: {data.get('current_day_key')}")

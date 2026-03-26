#!/usr/bin/env python3
"""Launch heavy historical sweep via API, then check status."""
import urllib.request
import urllib.error
import json

BASE = "http://127.0.0.1:3001"
AUTH = "Bearer SuperSecure2026Admin!"
HEADERS = {
    "Content-Type": "application/json",
    "Authorization": AUTH,
}

def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(
        BASE + path,
        data=data,
        headers=HEADERS,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode()
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode()
    except Exception as ex:
        return 0, str(ex)

# 1. Status check
code, body = call("GET", "/api/research/sweeps/full-historical/status")
print(f"STATUS {code}: {body[:500]}")

# 2. Launch
code, body = call("POST", "/api/research/sweeps/full-historical/start", {"mode": "heavy"})
print(f"START {code}: {body[:500]}")

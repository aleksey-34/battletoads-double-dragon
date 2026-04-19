#!/usr/bin/env python3
import json
from urllib import request

API_BASE = "http://127.0.0.1:3001"
ADMIN_TOKEN = "btdd_admin_sweep_2026"


def api_get(path: str):
    req = request.Request(
        f"{API_BASE}{path}",
        headers={"Authorization": f"Bearer {ADMIN_TOKEN}"},
        method="GET",
    )
    with request.urlopen(req, timeout=30) as resp:
        return json.loads(resp.read().decode("utf-8"))


def main():
    status = api_get("/api/research/sweeps/full-historical/status")
    print(json.dumps({"status": status}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
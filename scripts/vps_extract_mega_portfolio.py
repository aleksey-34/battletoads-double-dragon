#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"

con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

keys = [
    "offer.store.review_snapshots",
    "offer.store.ts_backtest_snapshots",
    "offer.store.labels",
    "offer.store.curated_ids",
    "offer.store.published_ids",
]

out = {}

for k in keys:
    row = cur.execute("SELECT value FROM app_runtime_flags WHERE key=?", (k,)).fetchone()
    if not row:
        out[k] = {"present": False}
        continue
    raw = row["value"] or ""
    try:
        data = json.loads(raw)
    except Exception as e:
        out[k] = {"present": True, "jsonError": str(e), "length": len(raw), "preview": raw[:400]}
        continue

    matches = []

    def scan(node, path="root"):
        if isinstance(node, dict):
            text = json.dumps(node, ensure_ascii=False)
            if "mega-portfolio" in text or "ALGOFUND_MASTER::BTDD_D1::mega-portfolio" in text:
                matches.append({"path": path, "node": node})
            for kk, vv in node.items():
                scan(vv, f"{path}.{kk}")
        elif isinstance(node, list):
            for i, vv in enumerate(node):
                scan(vv, f"{path}[{i}]")

    scan(data)
    out[k] = {
        "present": True,
        "type": type(data).__name__,
        "matchesCount": len(matches),
        "matches": matches[:20],
    }

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

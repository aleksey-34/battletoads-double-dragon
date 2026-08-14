#!/usr/bin/env python3
"""Write hamfive snapshot_json (incl. liveWindow + curves) onto algofund_portfolios."""
import json, os, sqlite3
from datetime import datetime, timezone
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
DATA = Path(__file__).resolve().parent / "portfolio_six_data_jul2026"
DB = os.environ.get("BTDD_DB_PATH") or "/opt/battletoads-double-dragon/backend/database.db"
snaps = json.loads((DATA / "snapshots_hamfive_aug2026.json").read_text())
recipes = json.loads((DATA / "recipes_hamfive_aug2026.json").read_text())
now = datetime.now(timezone.utc).isoformat()
conn = sqlite3.connect(DB)
n = 0
for pf in recipes["portfolios"]:
    snap = snaps.get(pf["id"])
    if not snap:
        continue
    row = conn.execute("SELECT id, metadata_json FROM algofund_portfolios WHERE set_key=?", (pf["setKey"],)).fetchone()
    if not row:
        print("miss", pf["id"], pf["setKey"])
        continue
    meta = {}
    try:
        meta = json.loads(row[1] or "{}")
    except json.JSONDecodeError:
        meta = {}
    meta["bt"] = {k: snap.get(k) for k in ("ret", "dd", "capital", "method", "dateFrom", "dateTo", "liveWindow")}
    conn.execute(
        "UPDATE algofund_portfolios SET snapshot_json=?, metadata_json=?, updated_at=? WHERE id=?",
        (json.dumps(snap, ensure_ascii=False), json.dumps(meta, ensure_ascii=False), now, row[0]),
    )
    n += 1
    lw = snap.get("liveWindow") or {}
    print(f"ok {pf['id']} {pf['setKey']} dateTo={snap.get('dateTo')} liveWin={lw.get('ret')}")
conn.commit()
print("updated", n)

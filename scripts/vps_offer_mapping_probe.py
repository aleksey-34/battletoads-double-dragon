#!/usr/bin/env python3
import json
import sqlite3

DB_PATH = "/opt/battletoads-double-dragon/backend/database.db"
con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

out = {}

tables = [r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").fetchall()]
offer_tables = [t for t in tables if "offer" in t.lower() or "catalog" in t.lower()]
out["offerTables"] = offer_tables

schemas = {}
for t in offer_tables:
    cols = [dict(name=r[1], type=r[2]) for r in cur.execute(f"PRAGMA table_info({t})").fetchall()]
    schemas[t] = cols
out["schemas"] = schemas

samples = {}
for t in offer_tables:
    try:
        rows = [dict(r) for r in cur.execute(f"SELECT * FROM {t} LIMIT 3").fetchall()]
    except Exception as e:
        rows = [{"error": str(e)}]
    samples[t] = rows
out["samples"] = samples

print(json.dumps(out, ensure_ascii=False, indent=2))
con.close()

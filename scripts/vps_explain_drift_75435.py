#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timezone

DB = "/opt/battletoads-double-dragon/backend/database.db"
STRATEGY_ID = 75435


def iso_ms(ms):
    if not ms:
        return None
    return datetime.fromtimestamp(int(ms) / 1000, tz=timezone.utc).isoformat()


def main():
    conn = sqlite3.connect(DB)
    conn.row_factory = sqlite3.Row

    alerts = conn.execute(
        """
        SELECT id, strategy_id, metric_name, severity, value, threshold, drift_percent, description, created_at
        FROM drift_alerts
        WHERE strategy_id = ?
        ORDER BY created_at DESC
        LIMIT 20
        """,
        (STRATEGY_ID,),
    ).fetchall()

    out_alerts = []
    for a in alerts:
        row = dict(a)
        row["created_at_utc"] = iso_ms(row.get("created_at"))
        out_alerts.append(row)

    reports = conn.execute(
        """
        SELECT rr.id, rr.period_hours, rr.samples_count, rr.metrics_json, rr.recommendation_json, rr.created_at, ak.name AS api_key_name
        FROM reconciliation_reports rr
        LEFT JOIN api_keys ak ON ak.id = rr.api_key_id
        WHERE rr.strategy_id = ?
        ORDER BY rr.created_at DESC
        LIMIT 10
        """,
        (STRATEGY_ID,),
    ).fetchall()

    out_reports = []
    for r in reports:
        row = dict(r)
        row["created_at_utc"] = iso_ms(row.get("created_at"))
        for k in ["metrics_json", "recommendation_json"]:
            raw = row.get(k)
            try:
                row[k] = json.loads(raw) if raw else None
            except Exception:
                row[k] = raw
        out_reports.append(row)

    print(json.dumps({"strategy_id": STRATEGY_ID, "alerts": out_alerts, "reports": out_reports}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

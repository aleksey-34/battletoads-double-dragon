#!/usr/bin/env python3
import json
import os
import sqlite3
from pathlib import Path

DB = "/opt/battletoads-double-dragon/backend/database.db"
TARGET_NEW = "ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh"
OLD_REMOVED = "ALGOFUND_MASTER::BTDD_D1::high-trade-curated-pu213v"
TARGET_SLUGS = {"btdd", "mehmet", "mustafa"}
KNOWN_AFFECTED_IDS = [1288, 41003, 43430]


def fetch_all(cur, sql, params=()):
    cur.execute(sql, params)
    cols = [c[0] for c in cur.description]
    return [dict(zip(cols, row)) for row in cur.fetchall()]


def tail_text(path: str, lines: int = 220) -> str:
    p = Path(path)
    if not p.exists():
        return ""
    try:
        txt = p.read_text(encoding="utf-8", errors="replace")
    except Exception:
        return ""
    arr = txt.splitlines()
    return "\n".join(arr[-lines:])


def main():
    if not os.path.exists(DB):
        print(json.dumps({"error": f"DB not found: {DB}"}, ensure_ascii=False, indent=2))
        return

    con = sqlite3.connect(DB)
    cur = con.cursor()

    clients = fetch_all(
        cur,
        """
        SELECT
          t.id,
          t.slug,
          t.display_name,
          COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name,
          ap.published_system_name,
          ap.requested_enabled,
          ap.actual_enabled,
          ap.updated_at
        FROM tenants t
        JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE lower(t.slug) IN ('btdd','mehmet','mustafa')
        ORDER BY lower(t.slug)
        """,
    )

    removed_audit = fetch_all(
        cur,
        """
        SELECT id, tenant_id, action, payload_json, created_at
        FROM saas_audit_log
        WHERE action = 'algofund_ts_removed'
           OR payload_json LIKE ?
        ORDER BY id DESC
        LIMIT 40
        """,
        (f"%{OLD_REMOVED}%",),
    )

    direct_actions = fetch_all(
        cur,
        """
        SELECT id, tenant_id, action, payload_json, created_at
        FROM saas_audit_log
        WHERE action = 'direct_algofund_action'
        ORDER BY id DESC
        LIMIT 80
        """,
    )

    request_rows = fetch_all(
        cur,
        """
        SELECT id, tenant_id, request_type, status, note, decision_note, request_payload_json, created_at, decided_at
        FROM algofund_start_stop_requests
        ORDER BY id DESC
        LIMIT 80
        """,
    )

    tenants_by_known_ids = fetch_all(
        cur,
        """
        SELECT
          t.id,
          t.slug,
          t.display_name,
          t.product_mode,
          t.assigned_api_key_name,
          ap.published_system_name,
          ap.requested_enabled,
          ap.actual_enabled,
          ap.execution_api_key_name,
          ap.updated_at
        FROM tenants t
        LEFT JOIN algofund_profiles ap ON ap.tenant_id = t.id
        WHERE t.id IN (1288, 41003, 43430)
        ORDER BY t.id
        """,
    )

    con.close()

    target_slug_map = {str(r.get("slug", "")).lower(): r for r in clients}
    status_summary = []
    for slug in ["btdd", "mehmet", "mustafa"]:
        row = target_slug_map.get(slug)
        if not row:
            status_summary.append({"slug": slug, "found": False})
            continue
        pub = str(row.get("published_system_name") or "")
        status_summary.append(
            {
                "slug": slug,
                "found": True,
                "tenant_id": row.get("id"),
                "display_name": row.get("display_name"),
                "published_system_name": pub,
                "is_on_new_system": pub == TARGET_NEW,
                "requested_enabled": row.get("requested_enabled"),
                "actual_enabled": row.get("actual_enabled"),
                "updated_at": row.get("updated_at"),
            }
        )

    # Scan latest logs for stop/close errors around algofund actions.
    log_candidates = [
        "/opt/battletoads-double-dragon/backend/logs/combined.log",
        "/root/.pm2/logs/btdd-api-error.log",
        "/root/.pm2/logs/btdd-api-out.log",
    ]
    log_text = "\n".join(tail_text(p, 260) for p in log_candidates)
    err_lines = []
    for line in log_text.splitlines():
        low = line.lower()
        if ("closeallpositions on stop" in low) or ("cancelallorders on stop" in low) or ("algofund batch action error" in low):
            err_lines.append(line)

    out = {
        "target": {
            "removed_system": OLD_REMOVED,
            "new_system": TARGET_NEW,
        },
        "clients_status": status_summary,
        "recent_removed_audit": removed_audit,
        "recent_direct_actions": direct_actions,
        "recent_requests": request_rows,
        "known_affected_tenants": tenants_by_known_ids,
        "error_lines_detected": err_lines[-40:],
    }
    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()

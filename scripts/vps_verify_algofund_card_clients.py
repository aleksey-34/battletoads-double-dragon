#!/usr/bin/env python3
import sqlite3
import json
from datetime import datetime

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
TARGET_SLUGS = {'mehmet-bingx', 'btdd-d1', 'ruslan', 'ali', 'mustafa'}


def safe_json(value, fallback):
    try:
        if value is None:
            return fallback
        if isinstance(value, (dict, list)):
            return value
        return json.loads(value)
    except Exception:
        return fallback


conn = sqlite3.connect(DB_PATH)
conn.row_factory = sqlite3.Row
c = conn.cursor()

report = {
    'timestamp_utc': datetime.utcnow().isoformat() + 'Z',
    'target_system': TARGET_SYSTEM,
    'checks': {},
    'clients': [],
}

# 1) Card/runtime TS exists and active
c.execute(
    '''SELECT ts.id, ts.name, ts.is_active, ak.name AS api_key_name,
              (SELECT COUNT(*) FROM trading_system_members tsm WHERE tsm.system_id = ts.id AND COALESCE(tsm.is_enabled,1)=1) AS members_count
       FROM trading_systems ts
       LEFT JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.name = ?
       ORDER BY ts.id DESC
       LIMIT 1''',
    (TARGET_SYSTEM,)
)
card_row = c.fetchone()
report['checks']['card_exists_in_ts'] = bool(card_row)
report['checks']['card_active_in_ts'] = bool(card_row and int(card_row['is_active'] or 0) == 1)
report['checks']['card_system_id'] = int(card_row['id']) if card_row else None
report['checks']['card_members_count'] = int(card_row['members_count']) if card_row else 0

# 2) Vitrine flag
c.execute(
    '''SELECT COUNT(*) AS cnt
       FROM algofund_active_systems
       WHERE system_name = ? AND COALESCE(is_enabled,1)=1''',
    (TARGET_SYSTEM,)
)
vitrine_count = int(c.fetchone()['cnt'])
report['checks']['vitrine_enabled_rows'] = vitrine_count
report['checks']['card_visible_on_vitrine'] = vitrine_count > 0

# 3) Snapshot metrics + settings saved
c.execute('SELECT value FROM app_runtime_flags WHERE key = ?', ('offer.store.ts_backtest_snapshots',))
snapshots_raw = c.fetchone()
snapshots_map = safe_json(snapshots_raw['value'] if snapshots_raw else '{}', {})
matched_snapshot = None
for key, snap in (snapshots_map or {}).items():
    if str((snap or {}).get('systemName', '')).strip() == TARGET_SYSTEM or str(key).strip() == TARGET_SYSTEM:
        matched_snapshot = snap
        break

report['checks']['metrics_saved_for_card'] = bool(matched_snapshot)
report['checks']['card_snapshot'] = {
    'ret': float((matched_snapshot or {}).get('ret', 0) or 0),
    'dd': float((matched_snapshot or {}).get('dd', 0) or 0),
    'pf': float((matched_snapshot or {}).get('pf', 0) or 0),
    'trades': int((matched_snapshot or {}).get('trades', 0) or 0),
    'backtestSettings': (matched_snapshot or {}).get('backtestSettings', {}) or {},
    'updatedAt': (matched_snapshot or {}).get('updatedAt', None),
}

# 4) Per-client checks
c.execute(
    '''SELECT t.id AS tenant_id, t.display_name, t.slug,
              ap.id AS profile_id, ap.published_system_name, ap.requested_enabled, ap.actual_enabled,
              ap.risk_multiplier, ap.assigned_api_key_name, ap.execution_api_key_name,
              ap.latest_preview_json,
              (SELECT MAX(created_at) FROM algofund_start_stop_requests r WHERE r.tenant_id = t.id) AS last_request_at,
              (SELECT r.status FROM algofund_start_stop_requests r WHERE r.tenant_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_request_status,
              (SELECT r.request_type FROM algofund_start_stop_requests r WHERE r.tenant_id = t.id ORDER BY r.id DESC LIMIT 1) AS last_request_type
       FROM tenants t
       LEFT JOIN algofund_profiles ap ON ap.tenant_id = t.id
       WHERE lower(t.slug) IN ({})
       ORDER BY t.id ASC'''.format(','.join(['?'] * len(TARGET_SLUGS))),
    tuple(sorted(TARGET_SLUGS))
)
rows = c.fetchall()

clients_ok_binding = 0
clients_ok_running = 0
for row in rows:
    latest_preview = safe_json(row['latest_preview_json'], {})
    source_system_name = str(((latest_preview or {}).get('sourceSystem') or {}).get('systemName', '')).strip()
    summary = (latest_preview or {}).get('summary') or {}

    bound_to_target = str(row['published_system_name'] or '').strip() == TARGET_SYSTEM
    running = int(row['requested_enabled'] or 0) == 1 and int(row['actual_enabled'] or 0) == 1
    preview_matches = source_system_name == TARGET_SYSTEM if source_system_name else None

    if bound_to_target:
        clients_ok_binding += 1
    if running:
        clients_ok_running += 1

    report['clients'].append({
        'tenant_id': int(row['tenant_id']),
        'display_name': str(row['display_name'] or ''),
        'slug': str(row['slug'] or ''),
        'profile_id': int(row['profile_id']) if row['profile_id'] is not None else None,
        'published_system_name': str(row['published_system_name'] or ''),
        'bound_to_target': bound_to_target,
        'requested_enabled': int(row['requested_enabled'] or 0),
        'actual_enabled': int(row['actual_enabled'] or 0),
        'running': running,
        'risk_multiplier': float(row['risk_multiplier'] or 0),
        'assigned_api_key_name': str(row['assigned_api_key_name'] or ''),
        'execution_api_key_name': str(row['execution_api_key_name'] or ''),
        'preview_source_system_name': source_system_name,
        'preview_matches_target': preview_matches,
        'preview_summary': {
            'ret': summary.get('totalReturnPercent'),
            'dd': summary.get('maxDrawdownPercent'),
            'pf': summary.get('profitFactor'),
            'trades': summary.get('tradesCount'),
        },
        'last_request_type': str(row['last_request_type'] or ''),
        'last_request_status': str(row['last_request_status'] or ''),
        'last_request_at': row['last_request_at'],
    })

report['checks']['clients_found'] = len(rows)
report['checks']['clients_bound_to_target'] = clients_ok_binding
report['checks']['clients_running'] = clients_ok_running
report['checks']['all_clients_bound'] = clients_ok_binding == len(rows) and len(rows) > 0
report['checks']['all_clients_running'] = clients_ok_running == len(rows) and len(rows) > 0
report['checks']['overall_ok'] = all([
    report['checks']['card_exists_in_ts'],
    report['checks']['card_active_in_ts'],
    report['checks']['card_visible_on_vitrine'],
    report['checks']['metrics_saved_for_card'],
    report['checks']['all_clients_bound'],
    report['checks']['all_clients_running'],
])

print(json.dumps(report, ensure_ascii=False, indent=2))
conn.close()

#!/usr/bin/env python3
import json
import sqlite3
import urllib.request
import urllib.error

DB = '/opt/battletoads-double-dragon/backend/database.db'
BASE = 'http://127.0.0.1:3001'
ADMIN_TOKEN = 'btdd_admin_sweep_2026'
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::mega-portfolio'
SOURCE_API_KEY = 'BTDD_D1'
TENANT_IDS = [41170, 41232]


def get_json(url: str):
    req = urllib.request.Request(url, headers={'Authorization': f'Bearer {ADMIN_TOKEN}'})
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode())


def post_json(url: str, payload: dict):
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode(),
        headers={
            'Authorization': f'Bearer {ADMIN_TOKEN}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.loads(r.read().decode())
    except urllib.error.HTTPError as error:
        body = error.read().decode(errors='ignore')
        return {
            'success': False,
            'httpStatus': error.code,
            'errorBody': body,
        }


def normalize_market_key(market: str) -> str:
    return str(market or '').strip().upper()


summary = get_json(f'{BASE}/api/saas/admin/summary')
offer_store = summary.get('offerStore') or {}
ts_snapshots = offer_store.get('tsBacktestSnapshots') or {}
all_offers = offer_store.get('offers') or []
offer_by_id = {str(o.get('offerId')): o for o in all_offers}

snapshot = ts_snapshots.get(TARGET_SYSTEM)
if not snapshot:
    raise RuntimeError(f'tsBacktestSnapshots missing target system: {TARGET_SYSTEM}')

offer_ids = list(snapshot.get('offerIds') or [])
if not offer_ids:
    raise RuntimeError(f'No offerIds in snapshot for {TARGET_SYSTEM}')

candidate_rows = []
for offer_id in offer_ids:
    offer = offer_by_id.get(str(offer_id)) or {}
    strategy_id = int(offer.get('strategyId') or 0)
    market = str(offer.get('market') or '').strip()
    if strategy_id <= 0 or not market:
        continue
    candidate_rows.append({
        'offerId': str(offer_id),
        'strategyId': strategy_id,
        'market': market,
        'mode': str(offer.get('mode') or ''),
        'strategyType': str((offer.get('backtestSettings') or {}).get('strategyType') or ''),
    })

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

result = {
    'targetSystem': TARGET_SYSTEM,
    'sourceApiKey': SOURCE_API_KEY,
    'snapshotOffers': len(candidate_rows),
    'tenants': [],
}

for tenant_id in TENANT_IDS:
    profile = cur.execute(
        '''
        SELECT ap.id AS profile_id,
               ap.tenant_id,
               COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name,
               COALESCE(t.slug, '') AS slug,
               COALESCE(t.display_name, '') AS display_name
        FROM algofund_profiles ap
        JOIN tenants t ON t.id = ap.tenant_id
        WHERE ap.tenant_id = ?
        LIMIT 1
        ''',
        (tenant_id,),
    ).fetchone()
    if not profile:
        result['tenants'].append({'tenantId': tenant_id, 'error': 'algofund profile not found'})
        continue

    api_key_name = str(profile['api_key_name'] or '').strip()
    if not api_key_name:
        result['tenants'].append({'tenantId': tenant_id, 'error': 'execution api key missing'})
        continue

    symbols = get_json(f'{BASE}/api/symbols/{api_key_name}')
    symbol_set = {normalize_market_key(s) for s in (symbols or [])}

    compatible = []
    missing = []
    for row in candidate_rows:
        market = normalize_market_key(row['market'])
        if market in symbol_set:
            compatible.append(row)
        else:
            missing.append(row)

    compatible_ids = [int(row['strategyId']) for row in compatible]

    copy_response = post_json(
        f'{BASE}/api/strategies/copy-block',
        {
            'sourceApiKey': SOURCE_API_KEY,
            'targetApiKey': api_key_name,
            'replaceTarget': True,
            'preserveActive': True,
            'syncSymbols': False,
            'sourceStrategyIds': compatible_ids,
        },
    ) if compatible_ids else {'success': False, 'error': 'no compatible strategy ids'}

    if not copy_response.get('success'):
        result['tenants'].append(
            {
                'tenantId': tenant_id,
                'slug': profile['slug'],
                'displayName': profile['display_name'],
                'apiKeyName': api_key_name,
                'compatibleCount': len(compatible),
                'missingCount': len(missing),
                'missingMarkets': sorted({row['market'] for row in missing}),
                'copySuccess': False,
                'copyError': copy_response,
                'runtimeTotal': 0,
                'runtimeActive': 0,
            }
        )
        continue

    if compatible_ids:
        placeholders = ','.join('?' for _ in compatible_ids)
        cur.execute(
            f'''
            UPDATE strategies
            SET is_runtime = 1,
                is_archived = 0,
                is_active = 1,
                origin = CASE
                  WHEN COALESCE(origin, '') IN ('', 'manual') THEN 'saas_materialize'
                  ELSE origin
                END,
                updated_at = CURRENT_TIMESTAMP
            WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
              AND id IN ({placeholders})
            ''',
            [api_key_name, *compatible_ids],
        )

    cur.execute(
        '''
        UPDATE algofund_profiles
        SET published_system_name = ?,
            requested_enabled = 1,
            actual_enabled = 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE tenant_id = ?
        ''',
        (TARGET_SYSTEM, tenant_id),
    )

    cur.execute(
        '''
        INSERT INTO algofund_active_systems (profile_id, system_name, weight, is_enabled, assigned_by, created_at, updated_at)
        VALUES (?, ?, 1, 1, 'admin', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(profile_id, system_name)
        DO UPDATE SET is_enabled = 1, updated_at = CURRENT_TIMESTAMP
        ''',
        (int(profile['profile_id']), TARGET_SYSTEM),
    )

    # Persist missing symbols as future issue records.
    for row in missing:
        cur.execute(
            '''
            INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
            VALUES (?, 'system', 'saas_materialize_pair_unavailable', ?, CURRENT_TIMESTAMP)
            ''',
            (
                tenant_id,
                json.dumps(
                    {
                        'apiKeyName': api_key_name,
                        'market': row['market'],
                        'offerId': row['offerId'],
                        'strategyId': row['strategyId'],
                        'reason': 'market_not_supported_on_exchange',
                        'sourceSystem': TARGET_SYSTEM,
                    },
                    ensure_ascii=False,
                ),
            ),
        )

    runtime_stats = cur.execute(
        '''
        SELECT COUNT(*) AS total,
               SUM(CASE WHEN COALESCE(s.is_active, 0) = 1 THEN 1 ELSE 0 END) AS active
        FROM strategies s
        JOIN api_keys ak ON ak.id = s.api_key_id
        WHERE ak.name = ?
          AND COALESCE(s.is_runtime, 0) = 1
          AND COALESCE(s.is_archived, 0) = 0
        ''',
        (api_key_name,),
    ).fetchone()

    result['tenants'].append(
        {
            'tenantId': tenant_id,
            'slug': profile['slug'],
            'displayName': profile['display_name'],
            'apiKeyName': api_key_name,
            'compatibleCount': len(compatible),
            'missingCount': len(missing),
            'missingMarkets': sorted({row['market'] for row in missing}),
            'copySuccess': bool(copy_response.get('success')),
            'runtimeTotal': int((runtime_stats['total'] if runtime_stats else 0) or 0),
            'runtimeActive': int((runtime_stats['active'] if runtime_stats else 0) or 0),
        }
    )

con.commit()
con.close()

print(json.dumps(result, ensure_ascii=False, indent=2))

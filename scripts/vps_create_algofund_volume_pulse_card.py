#!/usr/bin/env python3
import json
import sqlite3
from datetime import datetime, timezone

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
FLAG_KEY = 'offer.store.ts_backtest_snapshots'
SOURCE_KEY = 'ALGOFUND_MASTER::BTDD_D1::high-freq'
TARGET_KEY = 'ALGOFUND_MASTER::BTDD_D1::volume-pulse-v1'


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace('+00:00', 'Z')


con = sqlite3.connect(DB_PATH)
con.row_factory = sqlite3.Row
cur = con.cursor()

row = cur.execute('SELECT value FROM app_runtime_flags WHERE key = ?', (FLAG_KEY,)).fetchone()
if not row:
    print(json.dumps({'ok': False, 'error': f'flag_not_found:{FLAG_KEY}'}, ensure_ascii=False, indent=2))
    raise SystemExit(1)

try:
    snapshots = json.loads(row['value'] or '{}')
except Exception as exc:
    print(json.dumps({'ok': False, 'error': f'json_parse_error:{exc}'}, ensure_ascii=False, indent=2))
    raise SystemExit(1)

if not isinstance(snapshots, dict):
    print(json.dumps({'ok': False, 'error': 'flag_value_not_object'}, ensure_ascii=False, indent=2))
    raise SystemExit(1)

source = snapshots.get(SOURCE_KEY)
if not isinstance(source, dict):
    print(json.dumps({'ok': False, 'error': f'source_snapshot_not_found:{SOURCE_KEY}'}, ensure_ascii=False, indent=2))
    raise SystemExit(1)

target = dict(source)
target['setKey'] = TARGET_KEY
target['systemName'] = TARGET_KEY
target['updatedAt'] = now_iso()

# Keep measured snapshot metrics from source high-freq set.
# Ensure runtime-safe defaults for publish/use in Algofund UI.
settings = target.get('backtestSettings') if isinstance(target.get('backtestSettings'), dict) else {}
settings['maxOpenPositions'] = 4
if 'initialBalance' not in settings:
    settings['initialBalance'] = 10000
if 'riskScore' not in settings:
    settings['riskScore'] = 7
if 'tradeFrequencyScore' not in settings:
    settings['tradeFrequencyScore'] = 9
if 'riskScaleMaxPercent' not in settings:
    settings['riskScaleMaxPercent'] = 100

target['backtestSettings'] = settings

snapshots[TARGET_KEY] = target
serialized = json.dumps(snapshots, ensure_ascii=False)
cur.execute('UPDATE app_runtime_flags SET value = ? WHERE key = ?', (serialized, FLAG_KEY))
con.commit()

print(json.dumps({
    'ok': True,
    'sourceKey': SOURCE_KEY,
    'targetKey': TARGET_KEY,
    'ret': target.get('ret'),
    'pf': target.get('pf'),
    'dd': target.get('dd'),
    'trades': target.get('trades'),
    'tradesPerDay': target.get('tradesPerDay'),
    'periodDays': target.get('periodDays'),
    'offerIdsCount': len(target.get('offerIds') or []),
}, ensure_ascii=False, indent=2))

con.close()

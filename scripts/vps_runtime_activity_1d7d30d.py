#!/usr/bin/env python3
import json
import sqlite3
import time

DB = '/opt/battletoads-double-dragon/backend/database.db'
API_KEYS = ['HDB_15', 'HDB_18', 'ivan_weex_1']

con = sqlite3.connect(DB)
con.row_factory = sqlite3.Row
cur = con.cursor()

api = {r['name']: int(r['id']) for r in cur.execute("SELECT id,name FROM api_keys WHERE name IN (%s)" % ','.join('?' for _ in API_KEYS), API_KEYS).fetchall()}
now_ms = int(time.time() * 1000)
wins = {'1d': now_ms-86400000, '7d': now_ms-7*86400000, '30d': now_ms-30*86400000}

result = {'generatedAtMs': now_ms, 'systems': []}

for key in API_KEYS:
    aid = api.get(key)
    if not aid:
      result['systems'].append({'apiKeyName': key, 'error': 'api_key_not_found'})
      continue

    sids = [r['id'] for r in cur.execute(
        "SELECT id FROM strategies WHERE api_key_id=? AND COALESCE(is_runtime,1)=1 AND COALESCE(is_archived,0)=0",
        (aid,)
    ).fetchall()]

    if not sids:
      result['systems'].append({'apiKeyName': key, 'apiKeyId': aid, 'error': 'no_strategies'})
      continue

    ph = ','.join('?' for _ in sids)
    rows = [dict(r) for r in cur.execute(
        f"SELECT strategy_id,trade_type,source_symbol,created_at,position_size FROM live_trade_events WHERE strategy_id IN ({ph}) AND created_at>=? ORDER BY created_at DESC",
        (*sids, wins['30d'])
    ).fetchall()]

    windows = {}
    for label, start in wins.items():
        subset = [r for r in rows if int(r.get('created_at') or 0) >= start]
        entries = [r for r in subset if str(r.get('trade_type') or '').lower() == 'entry']
        exits = [r for r in subset if str(r.get('trade_type') or '').lower() in ('exit','close')]
        symbols = sorted({(r.get('source_symbol') or '').upper() for r in subset if (r.get('source_symbol') or '').strip()})
        zero_size_exits = sum(1 for r in exits if float(r.get('position_size') or 0) == 0.0)
        windows[label] = {
            'events': len(subset),
            'entries': len(entries),
            'exits': len(exits),
            'uniqueSymbols': len(symbols),
            'symbols': symbols,
            'zeroSizeExits': zero_size_exits,
        }

    result['systems'].append({
        'apiKeyName': key,
        'apiKeyId': aid,
        'strategyCount': len(sids),
        'windows': windows,
    })

print(json.dumps(result, ensure_ascii=False, indent=2))
con.close()

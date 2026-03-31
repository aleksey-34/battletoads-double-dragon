#!/usr/bin/env python3
import json
import sqlite3
import urllib.parse
import urllib.request
import urllib.error

BASE = 'http://127.0.0.1:3001/api'
AUTH = {'Authorization': 'Bearer SuperSecure2026Admin!'}
DB = '/opt/battletoads-double-dragon/backend/database.db'
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
KEYS = ['HDB_18', 'BTDD_D1', 'Mehmet_Bingx', 'mustafa', 'HDB_15']


def get(path, params=None):
    url = f"{BASE}{path}"
    if params:
        url += '?' + urllib.parse.urlencode(params)
    req = urllib.request.Request(url, headers=AUTH)
    with urllib.request.urlopen(req, timeout=90) as r:
        return json.loads(r.read().decode('utf-8'))


def get_safe(path, params=None):
    try:
        return {'ok': True, 'data': get(path, params)}
    except urllib.error.HTTPError as exc:
        body = ''
        try:
            body = exc.read().decode('utf-8', errors='ignore')
        except Exception:
            body = ''
        return {'ok': False, 'error': f'HTTP {exc.code}', 'body': body[:500]}
    except Exception as exc:
        return {'ok': False, 'error': str(exc), 'body': ''}


conn = sqlite3.connect(DB)
conn.row_factory = sqlite3.Row

strategy_rows = conn.execute(
    '''SELECT DISTINCT s.base_symbol
       FROM trading_systems ts
       JOIN trading_system_members tsm ON tsm.system_id = ts.id
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE ts.name = ? AND COALESCE(tsm.is_enabled,1)=1''',
    (TARGET_SYSTEM,)
).fetchall()

symbols = [str(r['base_symbol'] or '').strip().upper() for r in strategy_rows if str(r['base_symbol'] or '').strip()]
symbols = sorted(set(symbols))[:6]

quality = conn.execute(
    '''WITH target AS (
         SELECT ts.id AS system_id
         FROM trading_systems ts
         WHERE ts.name = ?
         LIMIT 1
       ), members AS (
         SELECT tsm.strategy_id
         FROM trading_system_members tsm
         JOIN target t ON t.system_id = tsm.system_id
         WHERE COALESCE(tsm.is_enabled,1)=1
       )
       SELECT
         COUNT(*) AS events_72h,
         SUM(CASE WHEN lower(COALESCE(lte.trade_type,''))='entry' THEN 1 ELSE 0 END) AS entries_72h,
         SUM(CASE WHEN lower(COALESCE(lte.trade_type,''))='exit' THEN 1 ELSE 0 END) AS exits_72h,
         SUM(CASE WHEN COALESCE(lte.source_order_id,'')<>'' THEN 1 ELSE 0 END) AS with_order_id_72h
       FROM live_trade_events lte
       JOIN members m ON m.strategy_id = lte.strategy_id
       WHERE lte.actual_time >= (strftime('%s','now','-72 hours')*1000)''',
    (TARGET_SYSTEM,)
).fetchone()

latest_events = conn.execute(
    '''WITH target AS (
         SELECT ts.id AS system_id
         FROM trading_systems ts
         WHERE ts.name = ?
         LIMIT 1
       ), members AS (
         SELECT tsm.strategy_id
         FROM trading_system_members tsm
         JOIN target t ON t.system_id = tsm.system_id
         WHERE COALESCE(tsm.is_enabled,1)=1
       )
       SELECT lte.strategy_id, lte.trade_type, lte.side, lte.entry_price, lte.actual_time, lte.source_order_id
       FROM live_trade_events lte
       JOIN members m ON m.strategy_id = lte.strategy_id
       ORDER BY lte.actual_time DESC
       LIMIT 10''',
    (TARGET_SYSTEM,)
).fetchall()

conn.close()

low_lot_resp = get_safe('/saas/admin/low-lot-recommendations', {'hours': 72, 'limit': 50})
low_lot = low_lot_resp.get('data') if low_lot_resp.get('ok') else {'items': []}
out = {
    'lowLotOk': bool(low_lot_resp.get('ok')),
    'lowLotError': low_lot_resp.get('error'),
    'lowLotItemsCount': len((low_lot or {}).get('items') or []),
    'lowLotSample': ((low_lot or {}).get('items') or [])[:8],
    'symbolsCheckedForTradesApi': symbols,
    'tradeEventQuality72h': {
        'events': int(quality['events_72h'] or 0),
        'entries': int(quality['entries_72h'] or 0),
        'exits': int(quality['exits_72h'] or 0),
        'withSourceOrderId': int(quality['with_order_id_72h'] or 0),
    },
    'latestTradeEvents': [dict(r) for r in latest_events],
    'perKeyTradesApi': [],
}

for key in KEYS:
    key_row = {
        'apiKey': key,
        'withoutSymbolCount': 0,
        'withSymbol': {},
    }
    trades_no_symbol_resp = get_safe(f"/trades/{urllib.parse.quote(key, safe='')}", {'limit': 50})
    trades_no_symbol = trades_no_symbol_resp.get('data') if trades_no_symbol_resp.get('ok') else []
    key_row['withoutSymbolCount'] = len(trades_no_symbol if isinstance(trades_no_symbol, list) else [])
    key_row['withoutSymbolError'] = trades_no_symbol_resp.get('error')
    for symbol in symbols[:3]:
        trades_with_symbol_resp = get_safe(f"/trades/{urllib.parse.quote(key, safe='')}", {'symbol': symbol, 'limit': 50})
        trades_with_symbol = trades_with_symbol_resp.get('data') if trades_with_symbol_resp.get('ok') else []
        key_row['withSymbol'][symbol] = {
            'count': len(trades_with_symbol if isinstance(trades_with_symbol, list) else []),
            'error': trades_with_symbol_resp.get('error'),
        }
    out['perKeyTradesApi'].append(key_row)

print(json.dumps(out, ensure_ascii=False, indent=2))

#!/usr/bin/env python3
import sqlite3
import json
import os
import urllib.parse
import urllib.request
from datetime import datetime

DB_PATH = '/opt/battletoads-double-dragon/backend/database.db'
ENV_PATH = '/opt/battletoads-double-dragon/backend/.env'
TARGET_SYSTEM = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
TARGET_SLUGS = ['mehmet-bingx', 'btdd-d1', 'ruslan', 'ali', 'mustafa']
LOOKBACK_HOURS = 24


def read_env_file(path: str) -> dict:
    out = {}
    if not os.path.exists(path):
        return out
    with open(path, 'r', encoding='utf-8', errors='ignore') as f:
        for raw in f:
            line = raw.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            k, v = line.split('=', 1)
            out[k.strip()] = v.strip().strip('"').strip("'")
    return out


def send_telegram(text: str) -> bool:
    env = read_env_file(ENV_PATH)
    token = (env.get('TELEGRAM_ADMIN_BOT_TOKEN') or os.environ.get('TELEGRAM_ADMIN_BOT_TOKEN') or '').strip()
    chat_id = (env.get('TELEGRAM_ADMIN_CHAT_ID') or os.environ.get('TELEGRAM_ADMIN_CHAT_ID') or '').strip()
    if not token or not chat_id:
        return False

    payload = {
        'chat_id': chat_id,
        'text': text,
        'disable_web_page_preview': True,
    }
    data = urllib.parse.urlencode(payload).encode('utf-8')
    req = urllib.request.Request(f'https://api.telegram.org/bot{token}/sendMessage', data=data, method='POST')
    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8', errors='replace')
        return '"ok":true' in body


def main() -> int:
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    c = conn.cursor()

    q_clients = '''
    SELECT t.id AS tenant_id, t.display_name, t.slug,
           ap.id AS profile_id,
           COALESCE(ap.published_system_name,'') AS published_system_name,
           COALESCE(ap.requested_enabled,0) AS requested_enabled,
           COALESCE(ap.actual_enabled,0) AS actual_enabled,
           COALESCE(ap.execution_api_key_name,'') AS execution_api_key_name,
           ts.id AS runtime_system_id,
           COALESCE(ts.is_active,0) AS runtime_active,
           (SELECT COUNT(*) FROM trading_system_members m WHERE m.system_id = ts.id AND COALESCE(m.is_enabled,1)=1) AS runtime_members,
           (
             SELECT COUNT(*)
             FROM trading_system_members tsm
             JOIN live_trade_events lte ON lte.strategy_id = tsm.strategy_id
             WHERE tsm.system_id = ts.id
               AND COALESCE(tsm.is_enabled,1)=1
               AND lte.actual_time >= (strftime('%s','now', ?) * 1000)
           ) AS trades_lookback
    FROM tenants t
    JOIN algofund_profiles ap ON ap.tenant_id = t.id
    LEFT JOIN api_keys ak ON ak.name = ap.execution_api_key_name
    LEFT JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = ('ALGOFUND::' || t.slug)
    WHERE lower(t.slug) IN ({})
    ORDER BY t.id ASC
    '''.format(','.join(['?'] * len(TARGET_SLUGS)))

    rows = c.execute(q_clients, (f'-{LOOKBACK_HOURS} hours', *TARGET_SLUGS)).fetchall()

    vitrine_rows = c.execute(
        '''SELECT COUNT(*) AS cnt
           FROM algofund_active_systems
           WHERE system_name = ? AND COALESCE(is_enabled,1)=1''',
        (TARGET_SYSTEM,)
    ).fetchone()['cnt']

    snapshot_row = c.execute(
        "SELECT value FROM app_runtime_flags WHERE key = 'offer.store.ts_backtest_snapshots'"
    ).fetchone()
    has_snapshot = False
    if snapshot_row and snapshot_row['value']:
        try:
            m = json.loads(snapshot_row['value'])
            for key, snap in (m or {}).items():
                if str((snap or {}).get('systemName', '')).strip() == TARGET_SYSTEM or str(key).strip() == TARGET_SYSTEM:
                    has_snapshot = True
                    break
        except Exception:
            has_snapshot = False

    bound = 0
    running = 0
    runtime_ok = 0
    total_trades = 0
    lines = []

    for r in rows:
        is_bound = str(r['published_system_name']).strip() == TARGET_SYSTEM
        is_running = int(r['requested_enabled']) == 1 and int(r['actual_enabled']) == 1
        is_runtime_ok = int(r['runtime_active'] or 0) == 1 and int(r['runtime_members'] or 0) > 0
        trades = int(r['trades_lookback'] or 0)

        if is_bound:
            bound += 1
        if is_running:
            running += 1
        if is_runtime_ok:
            runtime_ok += 1
        total_trades += trades

        lines.append(
            f"- {r['display_name']} ({r['slug']}): bound={is_bound} run={is_running} runtime={is_runtime_ok} trades24h={trades}"
        )

    total = len(rows)
    overall_ok = (
        total == 5
        and bound == total
        and running == total
        and runtime_ok == total
        and int(vitrine_rows) > 0
        and has_snapshot
    )

    status = 'OK' if overall_ok else 'ALERT'
    msg = [
        f"[{status}] Algofund card watchdog",
        f"Time UTC: {datetime.utcnow().strftime('%Y-%m-%d %H:%M:%S')}",
        f"System: {TARGET_SYSTEM}",
        f"Clients: {running}/{total} running, {bound}/{total} bound, runtime_ok {runtime_ok}/{total}",
        f"Vitrine enabled rows: {vitrine_rows}",
        f"Card metrics snapshot: {'yes' if has_snapshot else 'no'}",
        f"Trades last {LOOKBACK_HOURS}h (sum): {total_trades}",
        "",
        "Per client:",
        *lines,
    ]

    text = '\n'.join(msg)
    print(text)

    # Send only on alert by default. For manual run you can set WATCHDOG_FORCE_SEND=1.
    force_send = os.environ.get('WATCHDOG_FORCE_SEND', '0').strip() == '1'
    if (not overall_ok) or force_send:
        sent = send_telegram(text)
        print(f"telegram_sent={sent}")

    conn.close()
    return 0


if __name__ == '__main__':
    raise SystemExit(main())

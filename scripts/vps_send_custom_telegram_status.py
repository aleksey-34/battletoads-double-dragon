#!/usr/bin/env python3
import os
import json
import urllib.request
import urllib.parse
import subprocess

VERIFY_PATH = '/tmp/algofund_card_verify_after_fix.json'


def get_env_from_btdd_api():
    try:
        pid = subprocess.check_output("pgrep -f 'backend/dist/server.js|dist/server.js' | head -n 1", shell=True, text=True).strip()
        if not pid:
            return {}
        with open(f'/proc/{pid}/environ', 'rb') as f:
            raw = f.read().decode('utf-8', errors='ignore')
        pairs = [x for x in raw.split('\x00') if '=' in x]
        env = {}
        for item in pairs:
            k, v = item.split('=', 1)
            env[k] = v
        return env
    except Exception:
        return {}


def main():
    env = get_env_from_btdd_api()
    token = (env.get('TELEGRAM_ADMIN_BOT_TOKEN') or '').strip()
    chat_id = (env.get('TELEGRAM_ADMIN_CHAT_ID') or '').strip()

    if not token or not chat_id:
        print('NO_TELEGRAM_CREDS_IN_PROCESS_ENV')
        return

    verify = {}
    try:
        with open(VERIFY_PATH, 'r', encoding='utf-8') as f:
            verify = json.load(f)
    except Exception:
        verify = {}

    checks = verify.get('checks') or {}
    clients = verify.get('clients') or []

    lines = []
    lines.append('BTDD SaaS check: ts-multiset-v2-h6e6sh')
    lines.append(f"Overall: {'OK' if checks.get('overall_ok') else 'NOT_OK'}")
    lines.append(f"Card: active={checks.get('card_active_in_ts')} id={checks.get('card_system_id')} members={checks.get('card_members_count')}")
    lines.append(f"Vitrine: visible={checks.get('card_visible_on_vitrine')} rows={checks.get('vitrine_enabled_rows')}")
    snap = checks.get('card_snapshot') or {}
    lines.append(f"Metrics: ret={snap.get('ret')} dd={snap.get('dd')} pf={snap.get('pf')} trades={snap.get('trades')}")
    settings = snap.get('backtestSettings') or {}
    lines.append(f"Card settings: risk={settings.get('riskScore')} freq={settings.get('tradeFrequencyScore')} init={settings.get('initialBalance')} riskCap={settings.get('riskScaleMaxPercent')}")
    lines.append(f"Clients running: {checks.get('clients_running')}/{checks.get('clients_found')}")

    for c in clients:
        lines.append(
            f"- {c.get('display_name')} ({c.get('slug')}): bound={c.get('bound_to_target')} run={c.get('running')} req={c.get('requested_enabled')} act={c.get('actual_enabled')}"
        )

    text = '\n'.join(lines)

    payload = {
        'chat_id': chat_id,
        'text': text,
        'disable_web_page_preview': True,
    }
    data = urllib.parse.urlencode(payload).encode('utf-8')
    req = urllib.request.Request(f'https://api.telegram.org/bot{token}/sendMessage', data=data, method='POST')

    with urllib.request.urlopen(req, timeout=20) as resp:
        body = resp.read().decode('utf-8', errors='replace')
        if '"ok":true' in body:
            print('CUSTOM_TELEGRAM_SENT_OK')
        else:
            print('CUSTOM_TELEGRAM_SENT_WITH_UNKNOWN_RESPONSE')


if __name__ == '__main__':
    main()

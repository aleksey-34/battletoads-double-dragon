#!/usr/bin/env python3
"""
Диагностика и восстановление состояния БД:
- Проверяет наличие нужных карточек ТС (Алгофонд) и офферов (витрина стратегий)
- Добавляет недостающие карточки
- Синхронизирует client_presets в research.db из JSON-каталога
- Выводит полный отчёт о состоянии
"""
import sqlite3
import json
import os
import sys
import glob
from datetime import datetime

MAIN_DB    = '/opt/battletoads-double-dragon/backend/database.db'
RESEARCH_DB= '/opt/battletoads-double-dragon/research.db'
CATALOG_JSON = '/opt/battletoads-double-dragon/results/btdd_d1_client_catalog_2026-03-28T13-15-00-000Z.json'
BACKUP_RESEARCH = sorted(glob.glob('/opt/battletoads-double-dragon/backups/db/research_*.db'))

def check_backups():
    print('\n=== Бэкапы research.db ===')
    for f in BACKUP_RESEARCH:
        try:
            conn = sqlite3.connect(f)
            count = conn.execute('SELECT COUNT(*) FROM client_presets').fetchone()[0]
            if count > 0:
                sample = conn.execute("SELECT DISTINCT offer_id FROM client_presets WHERE is_current=1 LIMIT 3").fetchall()
                print(f'  {os.path.basename(f)}: {count} presets — {[r[0] for r in sample]}')
            conn.close()
        except Exception as e:
            pass  # таблица не существует в старых бэкапах

def get_main_state():
    conn = sqlite3.connect(MAIN_DB)
    print('\n=== Состояние main DB ===')
    ts = conn.execute('SELECT id, name, api_key_id, is_active FROM trading_systems ORDER BY id').fetchall()
    print(f'trading_systems: {len(ts)} записей')
    for row in ts:
        print(f'  [{row[0]}] {row[1]} | api_key_id={row[2]} | is_active={row[3]}')

    ap = conn.execute('SELECT id, tenant_id, actual_enabled, assigned_api_key_name, published_system_name FROM algofund_profiles').fetchall()
    print(f'\nalgofund_profiles: {len(ap)} записей')
    for row in ap:
        print(f'  id={row[0]} tenant={row[1]} enabled={row[2]} key={row[3]} system={row[4]}')

    ak = conn.execute('SELECT id, name FROM api_keys').fetchall()
    print(f'\napi_keys: {[r[1] for r in ak]}')
    conn.close()

def get_api_key_id(conn, name):
    row = conn.execute('SELECT id FROM api_keys WHERE name=?', (name,)).fetchone()
    return row[0] if row else None

ALGOFUND_TS_CARDS = [
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-synth-5pairs-v1',
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-mono-3markets-v1',
    'ALGOFUND_MASTER::BTDD_D1::ts-curated-balanced-7-v1',
]

def fix_algofund_ts_cards():
    conn = sqlite3.connect(MAIN_DB)
    api_key_id = get_api_key_id(conn, 'BTDD_D1')
    if not api_key_id:
        print('\n[ОШИБКА] API ключ BTDD_D1 не найден в базе!')
        conn.close()
        return

    print(f'\n=== Проверка Алгофонд ТС карточек (api_key_id={api_key_id}) ===')
    now = datetime.utcnow().isoformat()
    added = 0
    for name in ALGOFUND_TS_CARDS:
        exists = conn.execute('SELECT id FROM trading_systems WHERE name=?', (name,)).fetchone()
        if exists:
            print(f'  [OK] {name} уже есть (id={exists[0]})')
        else:
            conn.execute(
                '''INSERT INTO trading_systems (api_key_id, name, description, is_active,
                   auto_sync_members, discovery_enabled, max_members, created_at, updated_at)
                   VALUES (?, ?, '', 1, 0, 1, 8, ?, ?)''',
                (api_key_id, name, now, now)
            )
            print(f'  [ДОБАВЛЕНО] {name}')
            added += 1
    conn.commit()
    conn.close()
    print(f'  Итого добавлено: {added}')

def fix_offers_from_catalog():
    if not os.path.exists(CATALOG_JSON):
        print(f'\n[ОШИБКА] Файл каталога не найден: {CATALOG_JSON}')
        return

    with open(CATALOG_JSON) as f:
        catalog = json.load(f)

    offers = catalog.get('clientCatalog', {}).get('mono', []) + \
             catalog.get('clientCatalog', {}).get('synth', [])

    conn = sqlite3.connect(MAIN_DB)
    api_key_id = get_api_key_id(conn, 'BTDD_D1')
    if not api_key_id:
        print('\n[ОШИБКА] API ключ BTDD_D1 не найден!')
        conn.close()
        return

    print(f'\n=== Добавление офферов витрины ({len(offers)} штук) ===')
    now = datetime.utcnow().isoformat()
    added = 0
    for offer in offers:
        offer_id = offer.get('offerId', '')
        strategy = offer.get('strategy', {})
        strat_name = strategy.get('name', offer_id)
        description = offer.get('descriptionRu', '')

        exists = conn.execute(
            'SELECT id FROM trading_systems WHERE name=?', (strat_name,)
        ).fetchone()
        if exists:
            # Убедиться что is_active=1, discovery_enabled=1
            conn.execute(
                'UPDATE trading_systems SET is_active=1, discovery_enabled=1 WHERE id=?',
                (exists[0],)
            )
            print(f'  [ОБНОВЛЕНО] {strat_name} (id={exists[0]})')
        else:
            conn.execute(
                '''INSERT INTO trading_systems (api_key_id, name, description, is_active,
                   auto_sync_members, discovery_enabled, max_members, created_at, updated_at)
                   VALUES (?, ?, ?, 1, 0, 1, 1, ?, ?)''',
                (api_key_id, strat_name, description, now, now)
            )
            print(f'  [ДОБАВЛЕНО] {strat_name}')
            added += 1
    conn.commit()
    conn.close()
    print(f'  Итого добавлено: {added}')

def fix_client_presets_from_catalog():
    """Восстановить client_presets в research.db из JSON-каталога"""
    if not os.path.exists(CATALOG_JSON):
        print(f'\n[ОШИБКА] Файл каталога не найден: {CATALOG_JSON}')
        return

    with open(CATALOG_JSON) as f:
        catalog = json.load(f)

    mono   = catalog.get('clientCatalog', {}).get('mono', [])
    synth  = catalog.get('clientCatalog', {}).get('synth', [])
    offers = mono + synth

    conn = sqlite3.connect(RESEARCH_DB)
    # Убедиться что таблица существует
    try:
        conn.execute('SELECT COUNT(*) FROM client_presets').fetchone()
    except:
        print('\n[INFO] Таблица client_presets не существует в research.db — пропуск')
        conn.close()
        return

    existing = conn.execute("SELECT DISTINCT offer_id FROM client_presets WHERE is_current=1").fetchall()
    existing_ids = {r[0] for r in existing}

    print(f'\n=== Восстановление client_presets в research.db ===')
    print(f'  Уже есть: {len(existing_ids)} офферов: {sorted(existing_ids)}')

    now = datetime.utcnow().isoformat()
    added = 0
    for offer in offers:
        offer_id = offer.get('offerId', '')
        if not offer_id or offer_id in existing_ids:
            continue
        slider_presets = offer.get('sliderPresets', {})
        preset_json = json.dumps({
            'offerId': offer_id,
            'strategy': offer.get('strategy', {}),
            'sliderPresets': slider_presets,
            'metrics': offer.get('metrics', {}),
        })
        conn.execute(
            '''INSERT INTO client_presets (offer_id, preset_json, is_current, created_at, updated_at)
               VALUES (?, ?, 1, ?, ?)''',
            (offer_id, preset_json, now, now)
        )
        print(f'  [ДОБАВЛЕНО] {offer_id}')
        added += 1
    conn.commit()
    conn.close()
    print(f'  Итого добавлено: {added}')

def verify_clients_connected():
    conn = sqlite3.connect(MAIN_DB)
    print('\n=== Подключение клиентов к ts-multiset-v2-h6e6sh ===')
    ts_name = 'ALGOFUND_MASTER::BTDD_D1::ts-multiset-v2-h6e6sh'
    clients = conn.execute(
        '''SELECT ap.id, t.display_name, ap.actual_enabled, ap.assigned_api_key_name
           FROM algofund_profiles ap
           JOIN tenants t ON t.id = ap.tenant_id
           WHERE ap.published_system_name=?''',
        (ts_name,)
    ).fetchall()
    if clients:
        for c in clients:
            print(f'  [{c[0]}] {c[1]} | enabled={c[2]} | key={c[3]}')
    else:
        print('  [!] Нет подключённых клиентов!')
    conn.close()

def final_summary():
    conn = sqlite3.connect(MAIN_DB)
    print('\n=== Итоговое состояние ===')
    algofund_ts = conn.execute(
        "SELECT id, name, is_active FROM trading_systems WHERE name LIKE 'ALGOFUND_MASTER%' OR name LIKE 'ALGOFUND::%'"
    ).fetchall()
    print(f'Алгофонд ТС карточек: {len(algofund_ts)}')
    for r in algofund_ts:
        print(f'  [{r[0]}] {r[1]} | is_active={r[2]}')

    offer_ts = conn.execute(
        "SELECT COUNT(*) FROM trading_systems WHERE is_active=1 AND discovery_enabled=1 AND name NOT LIKE 'ALGOFUND%' AND name NOT LIKE 'ARCHIVED%' AND name NOT LIKE 'AB %' AND name NOT LIKE 'SWEEP %' AND name NOT LIKE 'HISTSWEEP %' AND name NOT LIKE 'HIGH-TRADE %'"
    ).fetchone()[0]
    print(f'\nОфферы витрины (is_active=1, discovery_enabled=1): {offer_ts}')
    conn.close()

    conn2 = sqlite3.connect(RESEARCH_DB)
    try:
        cp = conn2.execute("SELECT COUNT(*) FROM client_presets WHERE is_current=1").fetchone()[0]
        print(f'client_presets в research.db (is_current=1): {cp}')
    except:
        print('client_presets: таблица недоступна')
    conn2.close()

if __name__ == '__main__':
    print('=== ДИАГНОСТИКА И ВОССТАНОВЛЕНИЕ БД ===')
    check_backups()
    get_main_state()
    fix_algofund_ts_cards()
    fix_offers_from_catalog()
    fix_client_presets_from_catalog()
    verify_clients_connected()
    final_summary()
    print('\n[ГОТОВО]')

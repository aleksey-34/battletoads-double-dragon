#!/usr/bin/env ts-node
/**
 * Импорт офферов и ТС для витрины и Алгофонда с автоматической установкой статусов и подключением клиентов
 * Использует backend-логику и структуру БД
 */

import fs from 'fs';
import path from 'path';
import { initDB, db } from '../src/utils/database';
import { createTradingSystem } from '../src/bot/tradingSystems';

const CLIENT_CATALOG_PATH = path.resolve(__dirname, '../results/btdd_d1_client_catalog_2026-03-28T13-15-00-000Z.json');

const ALGOSYSTEMS = [
  {
    name: 'ts-multiset-v2-h6e6sh',
    description: 'BTDD D1 Алгофонд мультисет',
    clients: ['Mehmet_bingx', 'BTDD_D1', 'Ruslan', 'Ali', 'Mustafa'],
    is_active: true
  },
  { name: 'high-trade-curated-pu213v', description: '', clients: [], is_active: false },
  { name: 'ts-curated-synth-5pairs-v1', description: '', clients: [], is_active: false },
  { name: 'ts-curated-mono-3markets-v1', description: '', clients: [], is_active: false },
  { name: 'ts-curated-balanced-7-v1', description: '', clients: [], is_active: false }
];

async function main() {
  process.env.DB_FILE = path.resolve(__dirname, '../backend/database.db');
  await initDB();
  const raw = fs.readFileSync(CLIENT_CATALOG_PATH, 'utf8');
  const catalog = JSON.parse(raw);

  // 1. Импорт офферов (витрина)
  const offers = [...(catalog.clientCatalog.mono || []), ...(catalog.clientCatalog.synth || [])];
  for (const offer of offers) {
    const name = offer.strategy?.name || offer.offerId;
    await createTradingSystem('PHASE1_BACKTEST', {
      name,
      description: offer.descriptionRu || '',
      is_active: true,
      discovery_enabled: true,
      max_members: 1,
      members: [{ strategy_id: offer.strategy?.id, weight: 1, member_role: 'core', is_enabled: true }]
    });
    console.log(`[Оффер] ${name} импортирован на витрину`);
  }

  // 2. Импорт ТС для Алгофонда
  for (const ts of ALGOSYSTEMS) {
    await createTradingSystem('ALGOFUND_MASTER', {
      name: ts.name,
      description: ts.description,
      is_active: ts.is_active,
      discovery_enabled: true,
      max_members: 8,
      members: [] // Можно добавить состав, если есть id стратегий
    });
    console.log(`[ТС] ${ts.name} создана для Алгофонда`);
    // Подключение клиентов только к ts-multiset-v2-h6e6sh
    if (ts.clients.length) {
      for (const client of ts.clients) {
        await db.run(
          `INSERT OR IGNORE INTO strategy_client_profiles (tenant_id, active_system_profile_id, actual_enabled, assigned_api_key_name, created_at, updated_at)
           VALUES ((SELECT id FROM tenants WHERE name = ?), (SELECT id FROM trading_systems WHERE name = ?), 1, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
          [client, ts.name, client]
        );
        console.log(`[Клиент] ${client} подключён к ${ts.name}`);
      }
    }
  }

  console.log('✅ Импорт завершён!');
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Ошибка:', err.message);
  process.exit(1);
});

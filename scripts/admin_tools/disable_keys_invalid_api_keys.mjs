#!/usr/bin/env node
/**
 * Soft-disable API keys that should not be polled:
 *   - keys_invalid / deleted tenant leftovers
 *   - orphan keys with 0 active strategies and dead exchange auth (100413 / ACCESS_KEY)
 *
 *   node scripts/admin_tools/disable_keys_invalid_api_keys.mjs [--dry-run] [--probe-auth]
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../../backend');
const dryRun = process.argv.includes('--dry-run');
const probeAuth = process.argv.includes('--probe-auth') || !dryRun;

const { initDB } = require(path.join(backendRoot, 'dist/utils/database.js'));
const ex = probeAuth ? require(path.join(backendRoot, 'dist/bot/exchange.js')) : null;

const isDeadAuthError = (msg) => {
  const s = String(msg || '');
  return /100413|Incorrect apiKey|Invalid ACCESS_KEY|Invalid access_key|-1044|-1049|api key.*incorrect/i.test(s);
};

const main = async () => {
  await initDB();
  const { db } = require(path.join(backendRoot, 'dist/utils/database.js'));

  try {
    await db.run(`ALTER TABLE api_keys ADD COLUMN is_enabled INTEGER DEFAULT 1`);
  } catch {
    // already exists
  }

  const rows = await db.all(
    `SELECT DISTINCT a.id, a.name, a.exchange, COALESCE(a.is_enabled, 1) AS is_enabled
     FROM api_keys a
     WHERE COALESCE(a.is_enabled, 1) = 1
       AND (
         EXISTS (
           SELECT 1 FROM tenants t
           WHERE t.status IN ('deleted', 'keys_invalid')
             AND (
               t.assigned_api_key_name = a.name
               OR a.name = (t.slug || '-api')
               OR a.name = (t.slug || '-n-api')
               OR a.name LIKE (t.slug || '-%')
             )
         )
         OR EXISTS (
           SELECT 1 FROM algofund_profiles ap
           JOIN tenants t ON t.id = ap.tenant_id
           WHERE t.status IN ('deleted', 'keys_invalid')
             AND (ap.execution_api_key_name = a.name OR ap.assigned_api_key_name = a.name)
         )
         OR EXISTS (
           SELECT 1 FROM strategy_client_profiles sp
           JOIN tenants t ON t.id = sp.tenant_id
           WHERE t.status IN ('deleted', 'keys_invalid')
             AND sp.assigned_api_key_name = a.name
         )
       )
     ORDER BY a.name`,
  );

  console.log(`keys_invalid-linked enabled keys: ${rows.length}${dryRun ? ' (dry-run)' : ''}`);
  const toDisable = new Map(rows.map((r) => [r.id, r]));

  if (probeAuth && ex) {
    const orphans = await db.all(
      `SELECT a.id, a.name, a.exchange
       FROM api_keys a
       WHERE COALESCE(a.is_enabled, 1) = 1
         AND NOT EXISTS (
           SELECT 1 FROM strategies s
           WHERE s.api_key_id = a.id AND s.is_active = 1 AND IFNULL(s.is_archived, 0) = 0
         )
         AND NOT EXISTS (
           SELECT 1 FROM tenants t
           WHERE t.status NOT IN ('deleted', 'keys_invalid')
             AND (
               t.assigned_api_key_name = a.name
               OR t.slug = REPLACE(REPLACE(a.name, '-n-api', ''), '-api', '')
             )
         )
         AND NOT EXISTS (
           SELECT 1 FROM algofund_profiles ap
           JOIN tenants t ON t.id = ap.tenant_id
           WHERE t.status NOT IN ('deleted', 'keys_invalid')
             AND (ap.execution_api_key_name = a.name OR ap.assigned_api_key_name = a.name)
         )
       ORDER BY a.name`,
    );
    console.log(`orphan keys to probe auth: ${orphans.length}`);
    for (const r of orphans) {
      if (toDisable.has(r.id)) continue;
      try {
        await ex.ensureExchangeClientInitialized(r.name);
        await ex.getBalances(r.name);
        console.log(`  keep ${r.name} (${r.exchange}) auth ok`);
      } catch (e) {
        if (isDeadAuthError(e.message)) {
          console.log(`  disable orphan dead-auth ${r.name} (${r.exchange})`);
          toDisable.set(r.id, r);
        } else {
          console.log(`  keep ${r.name} probe err: ${String(e.message).slice(0, 80)}`);
        }
      }
    }
  }

  for (const r of toDisable.values()) {
    console.log(`  disable ${r.name} (${r.exchange}) id=${r.id}`);
    if (!dryRun) {
      await db.run(
        `UPDATE api_keys SET is_enabled = 0, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
        [r.id],
      );
    }
  }

  const left = await db.get(
    `SELECT COUNT(*) AS n FROM api_keys WHERE COALESCE(is_enabled, 1) = 0`,
  );
  const live = await db.get(
    `SELECT COUNT(*) AS n FROM api_keys WHERE COALESCE(is_enabled, 1) = 1`,
  );
  console.log(`done. disabled_total=${left?.n ?? '?'} enabled_live=${live?.n ?? '?'}`);
};

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

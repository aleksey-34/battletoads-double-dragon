#!/usr/bin/env node
/**
 * Soft-disable API keys tied to keys_invalid / deleted tenants.
 * Does NOT delete secrets — just sets is_enabled=0 so runtime skips poll/init.
 *
 *   node scripts/admin_tools/disable_keys_invalid_api_keys.mjs [--dry-run]
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.resolve(__dirname, '../../backend');
const dryRun = process.argv.includes('--dry-run');

const { initDB } = require(path.join(backendRoot, 'dist/utils/database.js'));

const main = async () => {
  await initDB();
  const { db } = require(path.join(backendRoot, 'dist/utils/database.js'));

  // Ensure column exists (initDB already ensureColumn, but be explicit).
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
  for (const r of rows) {
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

#!/usr/bin/env node
/**
 * Disable broken algofund profile artursk-6659194994 (stale key, no balance).
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BTDD_DB || path.resolve(__dirname, '../../backend/database.db');
const API_KEY = 'artursk-6659194994-api';

execFileSync('sqlite3', [dbPath, `
UPDATE algofund_profiles
SET requested_enabled = 0, actual_enabled = 0, updated_at = datetime('now')
WHERE COALESCE(execution_api_key_name, assigned_api_key_name) = '${API_KEY}';

UPDATE strategies
SET auto_update = 0, last_action = 'profile_disabled_broken_key'
WHERE api_key_id = (SELECT id FROM api_keys WHERE name = '${API_KEY}')
  AND COALESCE(is_active, 0) = 1;
`]);

const row = execFileSync('sqlite3', ['-header', '-column', dbPath, `
SELECT t.display_name, ap.requested_enabled, ap.actual_enabled
FROM algofund_profiles ap JOIN tenants t ON t.id = ap.tenant_id
WHERE COALESCE(ap.execution_api_key_name, ap.assigned_api_key_name) = '${API_KEY}';
`], { encoding: 'utf8' });

console.log(row);
console.log(JSON.stringify({ ok: true, api_key: API_KEY, action: 'disabled' }));

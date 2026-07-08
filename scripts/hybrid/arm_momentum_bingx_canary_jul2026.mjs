#!/usr/bin/env node
/**
 * Arm BingX momentum canary (HDB_15 by default).
 * Usage: node scripts/hybrid/arm_momentum_bingx_canary_jul2026.mjs [api_key_name]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BTDD_DB || path.resolve(__dirname, '../../backend/database.db');
const apiKeyName = String(process.argv[2] || process.env.MOMENTUM_BINGX_CANARY_API_KEY || 'HDB_15').trim();

const config = {
  enabled: true,
  apiKeyName,
  armedAt: new Date().toISOString(),
};
const value = JSON.stringify(config).replace(/'/g, "''");
execFileSync('sqlite3', [dbPath, `
INSERT INTO app_runtime_flags (key, value, updated_at)
VALUES ('runtime.momentum_bingx_canary', '${value}', datetime('now'))
ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at;
`], { stdio: 'pipe' });

console.log(JSON.stringify({ ok: true, ...config }, null, 2));

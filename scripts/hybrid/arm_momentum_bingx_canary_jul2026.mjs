#!/usr/bin/env node
/**
 * Arm BingX momentum canary (HDB_15 by default).
 * Usage: node scripts/hybrid/arm_momentum_bingx_canary_jul2026.mjs [api_key_name]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.BTDD_DB || path.resolve(__dirname, '../../backend/database.db');
const apiKeyName = String(process.argv[2] || process.env.MOMENTUM_BINGX_CANARY_API_KEY || 'HDB_15').trim();

const db = new Database(dbPath);
const config = {
  enabled: true,
  apiKeyName,
  armedAt: new Date().toISOString(),
};
db.prepare(
  `INSERT INTO app_runtime_flags (key, value, updated_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
).run('runtime.momentum_bingx_canary', JSON.stringify(config));
db.close();

console.log(JSON.stringify({ ok: true, ...config }, null, 2));

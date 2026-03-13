// Centralized defaults for BTDD HTTP helper scripts.
// Priority order: env vars > scripts/btdd_local.env > hardcoded fallback.
//
// To avoid passing AUTH_PASSWORD on every command, create:
//   scripts/btdd_local.env
// with content:
//   AUTH_PASSWORD=your_real_password
//   API_KEY_NAME=BTDD_D1
//   BASE_URL=http://127.0.0.1:3001/api
// This file is gitignored and never committed.

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const localEnvPath = path.join(__dirname, 'btdd_local.env');

const localEnv = {};
if (fs.existsSync(localEnvPath)) {
  const lines = fs.readFileSync(localEnvPath, 'utf-8').split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (key) localEnv[key] = value;
  }
}

const getDefault = (envKey, fileKey, fallback) =>
  process.env[envKey] || localEnv[fileKey || envKey] || fallback;

export const DEFAULT_API_KEY_NAME = getDefault('API_KEY_NAME', 'API_KEY_NAME', 'BTDD_D1');
export const DEFAULT_BASE_URL = getDefault('BASE_URL', 'BASE_URL', 'http://127.0.0.1:3001/api');
export const DEFAULT_AUTH_PASSWORD = getDefault('AUTH_PASSWORD', 'AUTH_PASSWORD', 'defaultpassword');

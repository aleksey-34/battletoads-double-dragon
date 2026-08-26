import { db } from '../utils/database';

/**
 * Gate for exchange polling (monitoring, delist watchdog, etc.).
 * Skip disabled keys and cabinets marked keys_invalid / deleted.
 */

export const isApiKeyRowEnabled = (row: { is_enabled?: unknown } | null | undefined): boolean => {
  if (!row) return false;
  // Missing column / NULL ⇒ treat as enabled (backward compatible).
  if (row.is_enabled === undefined || row.is_enabled === null) return true;
  return Number(row.is_enabled) !== 0;
};

/** Names that must not be hammered against the exchange. */
export const loadNonPollableApiKeyNames = async (): Promise<Set<string>> => {
  const out = new Set<string>();
  const rows = await db.all(
    `SELECT DISTINCT key_name FROM (
       SELECT TRIM(COALESCE(NULLIF(ap.execution_api_key_name, ''), ap.assigned_api_key_name, '')) AS key_name
       FROM algofund_profiles ap
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE t.status IN ('deleted', 'keys_invalid')
          OR COALESCE(json_extract(t.client_preferences_json, '$.keysInvalid'), 0) = 1
       UNION
       SELECT TRIM(COALESCE(sp.assigned_api_key_name, '')) AS key_name
       FROM strategy_client_profiles sp
       JOIN tenants t ON t.id = sp.tenant_id
       WHERE t.status IN ('deleted', 'keys_invalid')
          OR COALESCE(json_extract(t.client_preferences_json, '$.keysInvalid'), 0) = 1
       UNION
       SELECT TRIM(COALESCE(t.assigned_api_key_name, '')) AS key_name
       FROM tenants t
       WHERE t.status IN ('deleted', 'keys_invalid')
          OR COALESCE(json_extract(t.client_preferences_json, '$.keysInvalid'), 0) = 1
       UNION
       -- demat leftovers: slug-linked keys even when assigned_* was cleared
       SELECT a.name AS key_name
       FROM api_keys a
       JOIN tenants t ON (
         a.name = (t.slug || '-api')
         OR a.name = (t.slug || '-n-api')
         OR a.name LIKE (t.slug || '-%')
       )
       WHERE t.status IN ('deleted', 'keys_invalid')
       UNION
       SELECT name AS key_name FROM api_keys WHERE COALESCE(is_enabled, 1) = 0
     ) q
     WHERE key_name IS NOT NULL AND length(key_name) > 0`,
  ).catch(() => []);

  for (const row of Array.isArray(rows) ? rows : []) {
    const name = String((row as { key_name?: string })?.key_name || '').trim();
    if (name) out.add(name);
  }
  return out;
};

export const filterPollableApiKeyNames = async (names: string[]): Promise<string[]> => {
  const blocked = await loadNonPollableApiKeyNames();
  return Array.from(new Set(names.map((n) => String(n || '').trim()).filter(Boolean)))
    .filter((name) => !blocked.has(name));
};

export const loadPollableApiKeyNames = async (options?: {
  exchange?: string;
}): Promise<string[]> => {
  const exchange = String(options?.exchange || '').trim().toLowerCase();
  const rows = await db.all(
    exchange
      ? `SELECT name FROM api_keys WHERE LOWER(exchange) = ? AND COALESCE(is_enabled, 1) = 1`
      : `SELECT name FROM api_keys WHERE COALESCE(is_enabled, 1) = 1`,
    exchange ? [exchange] : [],
  ).catch(() => []);
  const names = (Array.isArray(rows) ? rows : [])
    .map((row) => String((row as { name?: string })?.name || '').trim())
    .filter(Boolean);
  return filterPollableApiKeyNames(names);
};

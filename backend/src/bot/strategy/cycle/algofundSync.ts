// All algofund clients now follow the standard reconciliation/alignment
// pipeline. Re-add a key to TS_SYNC_EXCLUDED_API_KEYS only as a temporary workaround.
export const TS_SYNC_EXCLUDED_API_KEYS = new Set<string>([]);

export const POSITION_ALIGNMENT_EXCLUDED_API_KEYS = new Set<string>([]);

export const extractSourceSid = (strategyName: string): string => {
  const m = String(strategyName || '').match(/::SID(\d+)$/);
  return m?.[1] ? m[1] : '';
};

/**
 * Expected live SIDs = union of ALGOFUND::{slug}::{b3|ham|five|stocks} books
 * on the execution key. `published_system_name` is a storefront set-key
 * (portfolio-balanced-jul2026), not a trading_systems.name — looking it up
 * as a TS name yields an empty set and the auto-cycle then runs EVERY
 * active strategy on the key (leftovers included).
 */
export const loadExpectedAlgofundSidMap = async (): Promise<Map<string, Set<string>>> => {
  const { db } = await import('../../../utils/database');
  const profiles: Array<{ execution_api_key_name: string; published_system_name: string }> = await db.all(
    `SELECT
       TRIM(COALESCE(execution_api_key_name, '')) AS execution_api_key_name,
       TRIM(COALESCE(published_system_name, '')) AS published_system_name
     FROM algofund_profiles
     WHERE COALESCE(requested_enabled, 0) = 1
       AND COALESCE(actual_enabled, 0) = 1
       AND TRIM(COALESCE(execution_api_key_name, '')) != ''`
  ) || [];

  const out = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const apiKeyName = String(profile.execution_api_key_name || '').trim();
    if (!apiKeyName) continue;
    if (TS_SYNC_EXCLUDED_API_KEYS.has(apiKeyName)) continue;

    const members: Array<{ strategy_id?: number; strategy_name?: string }> = await db.all(
      `SELECT s.id AS strategy_id, COALESCE(s.name, '') AS strategy_name
       FROM trading_systems ts
       JOIN api_keys a ON a.id = ts.api_key_id
       JOIN trading_system_members tsm ON tsm.system_id = ts.id
       JOIN strategies s ON s.id = tsm.strategy_id
       WHERE a.name = ?
         AND COALESCE(ts.is_active, 1) = 1
         AND COALESCE(tsm.is_enabled, 1) = 1
         AND (
           ts.name LIKE 'ALGOFUND::%'
           OR ts.name LIKE 'ALGOFUND::%'
           OR ts.name LIKE '%::b3'
           OR ts.name LIKE '%::ham'
           OR ts.name LIKE '%::five'
           OR ts.name LIKE '%::stocks'
                  )`,
      [apiKeyName],
    ) || [];

    const expected = new Set<string>();
    for (const row of members) {
      const cloneId = String(Number(row?.strategy_id || 0));
      if (cloneId !== '0') expected.add(cloneId);
      const sid = extractSourceSid(String(row?.strategy_name || ''));
      if (sid) expected.add(sid);
    }
    if (expected.size > 0) {
      out.set(apiKeyName, expected);
    }
  }

  return out;
};

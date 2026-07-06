// All algofund clients now follow the standard reconciliation/alignment
// pipeline. Re-add a key to TS_SYNC_EXCLUDED_API_KEYS only as a temporary workaround.
export const TS_SYNC_EXCLUDED_API_KEYS = new Set<string>([]);

export const POSITION_ALIGNMENT_EXCLUDED_API_KEYS = new Set<string>([]);

export const extractSourceSid = (strategyName: string): string => {
  const m = String(strategyName || '').match(/::SID(\d+)$/);
  return m?.[1] ? m[1] : '';
};

export const loadExpectedAlgofundSidMap = async (): Promise<Map<string, Set<string>>> => {
  const { db } = await import('../../../utils/database');
  const profiles: Array<{ execution_api_key_name: string; published_system_name: string }> = await db.all(
    `SELECT
       TRIM(COALESCE(execution_api_key_name, '')) AS execution_api_key_name,
       TRIM(COALESCE(published_system_name, '')) AS published_system_name
     FROM algofund_profiles
     WHERE COALESCE(requested_enabled, 0) = 1
       AND COALESCE(actual_enabled, 0) = 1
       AND TRIM(COALESCE(execution_api_key_name, '')) != ''
       AND TRIM(COALESCE(published_system_name, '')) != ''`
  ) || [];

  const out = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const apiKeyName = String(profile.execution_api_key_name || '').trim();
    const publishedSystemName = String(profile.published_system_name || '').trim();
    if (!apiKeyName || !publishedSystemName) continue;
    if (TS_SYNC_EXCLUDED_API_KEYS.has(apiKeyName)) continue;

    const systemRow: any = await db.get(
      `SELECT id
       FROM trading_systems
       WHERE name = ? OR name LIKE ?
       ORDER BY CASE WHEN name = ? THEN 1 ELSE 0 END DESC, id DESC
       LIMIT 1`,
      [publishedSystemName, `${publishedSystemName}::%`, publishedSystemName],
    );

    const systemId = Number(systemRow?.id || 0);
    if (!Number.isFinite(systemId) || systemId <= 0) {
      continue;
    }

    const members: Array<{ strategy_id: number }> = await db.all(
      `SELECT strategy_id
       FROM trading_system_members
       WHERE system_id = ?
         AND COALESCE(is_enabled, 1) = 1`,
      [systemId],
    ) || [];

    const expected = new Set<string>();
    for (const row of members) {
      const sid = String(Number(row?.strategy_id || 0));
      if (sid !== '0') expected.add(sid);
    }
    if (expected.size > 0) {
      out.set(apiKeyName, expected);
    }
  }

  return out;
};

import logger from '../../../utils/logger';

// All algofund clients now follow the standard reconciliation/alignment
// pipeline. Re-add a key to TS_SYNC_EXCLUDED_API_KEYS only as a temporary workaround.
export const TS_SYNC_EXCLUDED_API_KEYS = new Set<string>([]);

export const POSITION_ALIGNMENT_EXCLUDED_API_KEYS = new Set<string>([]);

export const ALGOFUND_BOOK_ROLES = ['b3', 'ham', 'five', 'stocks'] as const;
export type AlgofundBookRole = (typeof ALGOFUND_BOOK_ROLES)[number];

export const extractSourceSid = (strategyName: string): string => {
  const m = String(strategyName || '').match(/::SID(\d+)$/);
  return m?.[1] ? m[1] : '';
};

/** Storefront setKey like `portfolio-balanced-jul2026` — not a trading_systems.name. */
export const isStorefrontSetKey = (name: string): boolean => {
  const s = String(name || '').trim();
  if (!s || s.includes('::')) return false;
  return /^portfolio[-_]/i.test(s);
};

export const normalizePairLabel = (
  baseSymbol: string,
  quoteSymbol?: string,
  marketMode?: string,
): string => {
  const base = String(baseSymbol || '').replace(/[/-]/g, '').toUpperCase();
  const quote = String(quoteSymbol || '').replace(/[/-]/g, '').toUpperCase();
  const mode = String(marketMode || '').trim().toLowerCase();
  if (mode !== 'mono' && quote && quote !== base) {
    return `${base}/${quote}`;
  }
  return base || '?';
};

export const extractAlgofundBookRole = (systemName: string, slug: string): string => {
  const prefix = `ALGOFUND::${slug}::`;
  const name = String(systemName || '').trim();
  if (!name.startsWith(prefix)) return '';
  return name.slice(prefix.length).trim();
};

export type AlgofundRoleBookMember = {
  apiKeyName: string;
  slug: string;
  role: string;
  systemName: string;
  strategyId: number;
  strategyName: string;
  sourceSid: string;
  baseSymbol: string;
  quoteSymbol: string;
  interval: string;
  marketMode: string;
  isActive: number;
  isArchived: number;
  autoUpdate: number;
};

export const loadAlgofundRoleBookMembers = async (
  apiKeyName: string,
  slug?: string,
): Promise<AlgofundRoleBookMember[]> => {
  const key = String(apiKeyName || '').trim();
  if (!key) return [];
  const { db } = await import('../../../utils/database');

  let resolvedSlug = String(slug || '').trim();
  if (!resolvedSlug) {
    const row = await db.get(
      `SELECT TRIM(COALESCE(t.slug, '')) AS slug
       FROM algofund_profiles ap
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE TRIM(COALESCE(ap.execution_api_key_name, '')) = ?
       ORDER BY COALESCE(ap.actual_enabled, 0) DESC, ap.id DESC
       LIMIT 1`,
      [key],
    ) as { slug?: string } | undefined;
    resolvedSlug = String(row?.slug || '').trim();
  }
  if (!resolvedSlug) return [];

  const rows = await db.all(
    `SELECT
       ts.name AS system_name,
       s.id AS strategy_id,
       COALESCE(s.name, '') AS strategy_name,
       COALESCE(s.base_symbol, '') AS base_symbol,
       COALESCE(s.quote_symbol, '') AS quote_symbol,
       COALESCE(s.interval, '') AS interval,
       COALESCE(s.market_mode, '') AS market_mode,
       COALESCE(s.is_active, 0) AS is_active,
       COALESCE(s.is_archived, 0) AS is_archived,
       COALESCE(s.auto_update, 0) AS auto_update
     FROM trading_systems ts
     JOIN api_keys a ON a.id = ts.api_key_id
     JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled, 1) = 1
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE a.name = ?
       AND ts.name LIKE ?
       AND COALESCE(ts.is_active, 1) = 1`,
    [key, `ALGOFUND::${resolvedSlug}::%`],
  ) as Array<{
    system_name?: string;
    strategy_id?: number;
    strategy_name?: string;
    base_symbol?: string;
    quote_symbol?: string;
    interval?: string;
    market_mode?: string;
    is_active?: number;
    is_archived?: number;
    auto_update?: number;
  }>;

  const out: AlgofundRoleBookMember[] = [];
  for (const row of rows || []) {
    const systemName = String(row.system_name || '').trim();
    const role = extractAlgofundBookRole(systemName, resolvedSlug);
    const strategyId = Number(row.strategy_id || 0);
    if (!role || !Number.isFinite(strategyId) || strategyId <= 0) continue;
    const strategyName = String(row.strategy_name || '');
    out.push({
      apiKeyName: key,
      slug: resolvedSlug,
      role,
      systemName,
      strategyId,
      strategyName,
      sourceSid: extractSourceSid(strategyName),
      baseSymbol: String(row.base_symbol || ''),
      quoteSymbol: String(row.quote_symbol || ''),
      interval: String(row.interval || ''),
      marketMode: String(row.market_mode || ''),
      isActive: Number(row.is_active || 0) ? 1 : 0,
      isArchived: Number(row.is_archived || 0) ? 1 : 0,
      autoUpdate: Number(row.auto_update || 0) ? 1 : 0,
    });
  }
  return out;
};

const addExpectedTokens = (expected: Set<string>, member: { sourceSid: string; strategyId: number }): void => {
  if (member.sourceSid) expected.add(member.sourceSid);
  const liveId = String(Number(member.strategyId || 0));
  if (liveId !== '0') expected.add(liveId);
};

export const loadExpectedAlgofundSidMap = async (): Promise<Map<string, Set<string>>> => {
  const { db } = await import('../../../utils/database');
  const profiles: Array<{
    execution_api_key_name: string;
    published_system_name: string;
    slug: string;
  }> = await db.all(
    `SELECT
       TRIM(COALESCE(ap.execution_api_key_name, '')) AS execution_api_key_name,
       TRIM(COALESCE(ap.published_system_name, '')) AS published_system_name,
       TRIM(COALESCE(t.slug, '')) AS slug
     FROM algofund_profiles ap
     JOIN tenants t ON t.id = ap.tenant_id
     WHERE COALESCE(ap.requested_enabled, 0) = 1
       AND COALESCE(ap.actual_enabled, 0) = 1
       AND TRIM(COALESCE(ap.execution_api_key_name, '')) != ''`
  ) || [];

  const out = new Map<string, Set<string>>();
  for (const profile of profiles) {
    const apiKeyName = String(profile.execution_api_key_name || '').trim();
    const publishedSystemName = String(profile.published_system_name || '').trim();
    const slug = String(profile.slug || '').trim();
    if (!apiKeyName) continue;
    if (TS_SYNC_EXCLUDED_API_KEYS.has(apiKeyName)) continue;

    const expected = new Set<string>();
    const members = slug ? await loadAlgofundRoleBookMembers(apiKeyName, slug) : [];
    const roles = new Set<string>();
    for (const member of members) {
      roles.add(member.role);
      addExpectedTokens(expected, member);
    }

    // Never treat a storefront setKey as a trading_systems.name — that LIMIT 1 miss
    // used to leave expected empty, so auto-cycle ran every leftover strategy on the key.
    if (expected.size === 0 && publishedSystemName && !isStorefrontSetKey(publishedSystemName)) {
      const systemRow: any = await db.get(
        `SELECT id
         FROM trading_systems
         WHERE name = ? OR name LIKE ?
         ORDER BY CASE WHEN name = ? THEN 1 ELSE 0 END DESC, id DESC
         LIMIT 1`,
        [publishedSystemName, `${publishedSystemName}::%`, publishedSystemName],
      );
      const systemId = Number(systemRow?.id || 0);
      if (Number.isFinite(systemId) && systemId > 0) {
        const tsMembers: Array<{ strategy_id: number; name?: string }> = await db.all(
          `SELECT tsm.strategy_id, COALESCE(s.name, '') AS name
           FROM trading_system_members tsm
           JOIN strategies s ON s.id = tsm.strategy_id
           WHERE tsm.system_id = ?
             AND COALESCE(tsm.is_enabled, 1) = 1`,
          [systemId],
        ) || [];
        for (const row of tsMembers) {
          addExpectedTokens(expected, {
            sourceSid: extractSourceSid(String(row?.name || '')),
            strategyId: Number(row?.strategy_id || 0),
          });
        }
      }
    }

    if (expected.size > 0) {
      out.set(apiKeyName, expected);
      logger.info(
        `Algofund expected SID map ${apiKeyName}: ${expected.size} tokens `
        + `from books [${[...roles].join(',') || 'legacy-ts'}] slug=${slug || '-'} `
        + `published=${publishedSystemName || '-'}`,
      );
    } else {
      logger.warn(
        `Algofund expected SID map EMPTY for ${apiKeyName} `
        + `(slug=${slug || '-'} published=${publishedSystemName || '-'} `
        + `setKey=${isStorefrontSetKey(publishedSystemName) ? 'yes' : 'no'}). `
        + 'Auto-cycle will not archive extras until ALGOFUND::{slug}::{role} books exist.',
      );
    }
  }

  return out;
};

import { getMonitoringLatest, getMonitoringSnapshots } from '../bot/monitoring';
import { db } from '../utils/database';

const asString = (v: unknown, fallback = ''): string => {
  const s = String(v ?? '').trim();
  return s || fallback;
};

const asNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const partnerSlugPrefixes = (): string[] => {
  const raw = String(process.env.PARTNER_TENANT_SLUG_PREFIXES || 'artursk').trim();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
};

const partnerExtraSlugs = (): Set<string> => {
  const raw = String(process.env.PARTNER_TENANT_EXTRA_SLUGS || '').trim();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
};

const isPartnerTenantSlug = (slug: string): boolean => {
  const s = slug.trim().toLowerCase();
  if (!s) return false;
  if (partnerExtraSlugs().has(s)) return true;
  return partnerSlugPrefixes().some((prefix) => s.startsWith(prefix));
};

export const getPartnerDashboard = async () => {
  const rows = await db.all(
    `SELECT t.id, t.slug, t.display_name, t.status,
            ap.published_system_name, ap.actual_enabled, ap.execution_api_key_name,
            ap.assigned_api_key_name, ap.requested_enabled
     FROM tenants t
     JOIN algofund_profiles ap ON ap.tenant_id = t.id
     WHERE t.status = 'active'
     ORDER BY t.slug`,
  ).catch(() => []) as Array<Record<string, unknown>>;

  const clients = [];
  for (const row of rows) {
    const slug = asString(row.slug);
    if (!isPartnerTenantSlug(slug)) continue;
    const apiKey = asString(row.execution_api_key_name) || asString(row.assigned_api_key_name);
    const monitoring = apiKey
      ? await getMonitoringLatest(apiKey).catch(() => null)
      : null;
    clients.push({
      tenantId: asNumber(row.id),
      slug,
      displayName: asString(row.display_name, slug),
      apiKeyName: apiKey,
      publishedSystem: asString(row.published_system_name),
      enabled: asNumber(row.actual_enabled) === 1,
      monitoring: monitoring ? {
        equityUsd: asNumber(monitoring.equity_usd),
        unrealizedPnl: asNumber(monitoring.unrealized_pnl),
        marginLoadPercent: asNumber(monitoring.margin_load_percent),
        drawdownPercent: asNumber(monitoring.drawdown_percent),
        effectiveLeverage: asNumber(monitoring.effective_leverage),
        pnlNetUsd: monitoring.pnl_net_usd != null ? asNumber(monitoring.pnl_net_usd) : null,
        recordedAt: asString(monitoring.recorded_at),
      } : null,
    });
  }

  return {
    generatedAt: new Date().toISOString(),
    slugPrefixes: partnerSlugPrefixes(),
    clients,
    totals: {
      clients: clients.length,
      enabled: clients.filter((c) => c.enabled).length,
      onV42: clients.filter((c) => c.publishedSystem.includes('v4-2')).length,
    },
  };
};

export const getPartnerMonitoringSeries = async (
  apiKeyName: string,
  options?: { days?: number; limit?: number },
) => {
  const days = asNumber(options?.days, 0);
  const limit = asNumber(options?.limit, 288);
  const points = days > 1
    ? await getMonitoringSnapshots(apiKeyName, 5000, days).catch(() => [])
    : await getMonitoringSnapshots(apiKeyName, limit).catch(() => []);
  const latest = await getMonitoringLatest(apiKeyName).catch(() => null);
  return { points, latest };
};

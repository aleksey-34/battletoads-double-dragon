import { getMonitoringLatest, getMonitoringSnapshots, recordMonitoringSnapshot } from '../bot/monitoring';
import { db } from '../utils/database';

const sleepMs = (ms: number) => new Promise<void>((resolve) => { setTimeout(resolve, Math.max(0, ms)); });

const asString = (v: unknown, fallback = ''): string => {
  const s = String(v ?? '').trim();
  return s || fallback;
};

const asNumber = (v: unknown, fallback = 0): number => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};

const PARTNER_LIVE_REFRESH_COOLDOWN_MS = Math.max(
  60_000,
  asNumber(process.env.PARTNER_LIVE_REFRESH_COOLDOWN_MS, 3_600_000),
);
let lastPartnerLiveRefreshAt = 0;

const partnerLiveRefreshAllowed = (): { allowed: boolean; retryAfterSec: number } => {
  const elapsed = Date.now() - lastPartnerLiveRefreshAt;
  if (elapsed >= PARTNER_LIVE_REFRESH_COOLDOWN_MS) {
    return { allowed: true, retryAfterSec: 0 };
  }
  return {
    allowed: false,
    retryAfterSec: Math.ceil((PARTNER_LIVE_REFRESH_COOLDOWN_MS - elapsed) / 1000),
  };
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

const getTsMemberCount = async (slug: string): Promise<number> => {
  const row = await db.get<{ cnt?: number }>(
    `SELECT COUNT(*) AS cnt
     FROM trading_system_members m
     JOIN trading_systems ts ON ts.id = m.system_id
     WHERE ts.name = ?`,
    [`ALGOFUND::${slug}`],
  ).catch(() => null);
  return Math.max(0, asNumber(row?.cnt, 0));
};

const snapshotAgeMinutes = (recordedAt: string): number | null => {
  const ts = Date.parse(recordedAt);
  if (!Number.isFinite(ts)) return null;
  return Math.max(0, Math.round((Date.now() - ts) / 60_000));
};

export const getPartnerDashboard = async (options?: { refresh?: boolean }) => {
  const refreshGate = options?.refresh ? partnerLiveRefreshAllowed() : null;
  const doLiveRefresh = Boolean(options?.refresh && refreshGate?.allowed);

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
    const publishedSystem = asString(row.published_system_name);
    const tsMemberCount = await getTsMemberCount(slug);
    const tsExpected = publishedSystem.includes('v4-2') ? 20 : 0;

    if (doLiveRefresh && apiKey) {
      await recordMonitoringSnapshot(apiKey).catch(() => null);
      // WEEX rate limits: gentle spacing between clients
      await sleepMs(2500);
    }

    const monitoring = apiKey
      ? await getMonitoringLatest(apiKey).catch(() => null)
      : null;
    const recordedAt = monitoring ? asString(monitoring.recorded_at) : '';
    clients.push({
      tenantId: asNumber(row.id),
      slug,
      displayName: asString(row.display_name, slug),
      apiKeyName: apiKey,
      publishedSystem,
      enabled: asNumber(row.actual_enabled) === 1,
      tsMemberCount,
      tsExpected: tsExpected > 0 ? tsExpected : null,
      tsComplete: tsExpected > 0 ? tsMemberCount >= tsExpected : null,
      monitoring: monitoring ? {
        equityUsd: asNumber(monitoring.equity_usd),
        unrealizedPnl: asNumber(monitoring.unrealized_pnl),
        marginLoadPercent: asNumber(monitoring.margin_load_percent),
        drawdownPercent: asNumber(monitoring.drawdown_percent),
        effectiveLeverage: asNumber(monitoring.effective_leverage),
        pnlNetUsd: monitoring.pnl_net_usd != null ? asNumber(monitoring.pnl_net_usd) : null,
        recordedAt,
        ageMinutes: recordedAt ? snapshotAgeMinutes(recordedAt) : null,
      } : null,
    });
  }

  if (doLiveRefresh) {
    lastPartnerLiveRefreshAt = Date.now();
  }

  return {
    generatedAt: new Date().toISOString(),
    refreshed: doLiveRefresh,
    refreshSkipped: Boolean(options?.refresh && !doLiveRefresh),
    refreshRetryAfterSec: refreshGate && !refreshGate.allowed ? refreshGate.retryAfterSec : 0,
    liveRefreshCooldownSec: Math.round(PARTNER_LIVE_REFRESH_COOLDOWN_MS / 1000),
    slugPrefixes: partnerSlugPrefixes(),
    clients,
    totals: {
      clients: clients.length,
      enabled: clients.filter((c) => c.enabled).length,
      onV42: clients.filter((c) => c.publishedSystem.includes('v4-2')).length,
      tsComplete: clients.filter((c) => c.tsComplete === true).length,
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

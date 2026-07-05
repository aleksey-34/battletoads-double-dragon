import { runMonitoringCycleForApiKeys } from '../automation/scheduler';
import { getMonitoringLatest, getMonitoringSnapshots } from '../bot/monitoring';
import { db } from '../utils/database';
import logger from '../utils/logger';

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

export const partnerSlugPrefixes = (): string[] => {
  const raw = String(process.env.PARTNER_TENANT_SLUG_PREFIXES || 'artursk').trim();
  return raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
};

const partnerExtraSlugs = (): Set<string> => {
  const raw = String(process.env.PARTNER_TENANT_EXTRA_SLUGS || '').trim();
  return new Set(raw.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));
};

export const isPartnerTenantSlug = (slug: string): boolean => {
  const s = slug.trim().toLowerCase();
  if (!s) return false;
  if (partnerExtraSlugs().has(s)) return true;
  return partnerSlugPrefixes().some((prefix) => s.startsWith(prefix));
};

type PartnerClientRow = {
  tenantId: number;
  slug: string;
  displayName: string;
  apiKeyName: string;
  publishedSystem: string;
  enabled: boolean;
};

type PartnerRefreshJob = {
  status: 'idle' | 'running' | 'done' | 'error';
  startedAt: string | null;
  finishedAt: string | null;
  total: number;
  done: number;
  failed: number;
  current: string | null;
  errors: string[];
};

let partnerRefreshJob: PartnerRefreshJob = {
  status: 'idle',
  startedAt: null,
  finishedAt: null,
  total: 0,
  done: 0,
  failed: 0,
  current: null,
  errors: [],
};

const loadPartnerClientRows = async (): Promise<PartnerClientRow[]> => {
  const rows = await db.all(
    `SELECT t.id, t.slug, t.display_name, t.status,
            ap.published_system_name, ap.actual_enabled, ap.execution_api_key_name,
            ap.assigned_api_key_name, ap.requested_enabled
     FROM tenants t
     JOIN algofund_profiles ap ON ap.tenant_id = t.id
     WHERE t.status = 'active'
     ORDER BY t.slug`,
  ).catch(() => []) as Array<Record<string, unknown>>;

  const clients: PartnerClientRow[] = [];
  for (const row of rows) {
    const slug = asString(row.slug);
    if (!isPartnerTenantSlug(slug)) continue;
    clients.push({
      tenantId: asNumber(row.id),
      slug,
      displayName: asString(row.display_name, slug),
      apiKeyName: asString(row.execution_api_key_name) || asString(row.assigned_api_key_name),
      publishedSystem: asString(row.published_system_name),
      enabled: asNumber(row.actual_enabled) === 1,
    });
  }
  return clients;
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

const buildClientPayload = async (row: PartnerClientRow) => {
  const tsMemberCount = await getTsMemberCount(row.slug);
  const tsExpected = row.publishedSystem.includes('v4-2') ? 20 : 0;
  const monitoring = row.apiKeyName
    ? await getMonitoringLatest(row.apiKeyName).catch(() => null)
    : null;
  const recordedAt = monitoring ? asString(monitoring.recorded_at) : '';
  return {
    tenantId: row.tenantId,
    slug: row.slug,
    displayName: row.displayName,
    apiKeyName: row.apiKeyName,
    publishedSystem: row.publishedSystem,
    enabled: row.enabled,
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
  };
};

export const getPartnerRefreshStatus = () => ({ ...partnerRefreshJob });

export const startPartnerLiveRefresh = async (): Promise<{
  started: boolean;
  refreshSkipped?: boolean;
  refreshRetryAfterSec?: number;
  job: PartnerRefreshJob;
}> => {
  if (partnerRefreshJob.status === 'running') {
    return { started: true, job: { ...partnerRefreshJob } };
  }

  const refreshGate = partnerLiveRefreshAllowed();
  if (!refreshGate.allowed) {
    return {
      started: false,
      refreshSkipped: true,
      refreshRetryAfterSec: refreshGate.retryAfterSec,
      job: { ...partnerRefreshJob },
    };
  }

  const clients = await loadPartnerClientRows();
  const apiKeys = clients.map((c) => c.apiKeyName).filter(Boolean);
  lastPartnerLiveRefreshAt = Date.now();

  partnerRefreshJob = {
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    total: apiKeys.length,
    done: 0,
    failed: 0,
    current: null,
    errors: [],
  };

  void (async () => {
    try {
      const result = await runMonitoringCycleForApiKeys(apiKeys, (progress) => {
        partnerRefreshJob = {
          ...partnerRefreshJob,
          done: progress.done,
          failed: progress.failed,
          current: progress.current || null,
        };
      });
      partnerRefreshJob = {
        ...partnerRefreshJob,
        status: result.failed > 0 && result.processed === 0 ? 'error' : 'done',
        finishedAt: new Date().toISOString(),
        done: result.processed + result.failed,
        failed: result.failed,
        current: null,
      };
      logger.info(`[partner-refresh] finished processed=${result.processed} failed=${result.failed}`);
    } catch (error) {
      partnerRefreshJob = {
        ...partnerRefreshJob,
        status: 'error',
        finishedAt: new Date().toISOString(),
        current: null,
        errors: [...partnerRefreshJob.errors, String((error as Error)?.message || error)],
      };
      logger.warn(`[partner-refresh] failed: ${(error as Error)?.message}`);
    }
  })();

  return { started: true, job: { ...partnerRefreshJob } };
};

export const getPartnerDashboard = async (options?: { refresh?: boolean }) => {
  if (options?.refresh) {
    await startPartnerLiveRefresh();
  }

  const clients = [];
  for (const row of await loadPartnerClientRows()) {
    clients.push(await buildClientPayload(row));
  }

  const refreshGate = partnerLiveRefreshAllowed();

  return {
    generatedAt: new Date().toISOString(),
    refreshed: partnerRefreshJob.status === 'running',
    refreshJob: { ...partnerRefreshJob },
    refreshSkipped: false,
    refreshRetryAfterSec: refreshGate.allowed ? 0 : refreshGate.retryAfterSec,
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

export type PartnerTradeSummaryRow = {
  slug: string;
  displayName: string;
  apiKeyName: string;
  publishedSystem: string;
  tradesCount: number;
  entries: number;
  exits: number;
  lastTradeAt: string | null;
  deviationPct: number | null;
  isOutlier: boolean;
};

export const getPartnerTradesSummary = async (periodHours = 6): Promise<{
  periodHours: number;
  generatedAt: string;
  systemMedian: number;
  rows: PartnerTradeSummaryRow[];
  outliers: PartnerTradeSummaryRow[];
}> => {
  const hours = Math.max(1, Math.min(168, Math.floor(periodHours)));
  const sinceMs = Date.now() - hours * 3_600_000;

  const clients = await loadPartnerClientRows();
  const rows: PartnerTradeSummaryRow[] = [];

  for (const client of clients) {
    if (!client.apiKeyName) {
      rows.push({
        slug: client.slug,
        displayName: client.displayName,
        apiKeyName: '',
        publishedSystem: client.publishedSystem,
        tradesCount: 0,
        entries: 0,
        exits: 0,
        lastTradeAt: null,
        deviationPct: null,
        isOutlier: false,
      });
      continue;
    }

    const stats = await db.get<{
      trades_count?: number;
      entries?: number;
      exits?: number;
      last_trade_at?: number;
    }>(
      `SELECT
         COUNT(*) AS trades_count,
         SUM(CASE WHEN lte.trade_type = 'entry' THEN 1 ELSE 0 END) AS entries,
         SUM(CASE WHEN lte.trade_type = 'exit' THEN 1 ELSE 0 END) AS exits,
         MAX(lte.actual_time) AS last_trade_at
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ?
         AND lte.actual_time >= ?`,
      [client.apiKeyName, sinceMs],
    ).catch(() => null);

    const tradesCount = Math.max(0, asNumber(stats?.trades_count, 0));
    rows.push({
      slug: client.slug,
      displayName: client.displayName,
      apiKeyName: client.apiKeyName,
      publishedSystem: client.publishedSystem,
      tradesCount,
      entries: Math.max(0, asNumber(stats?.entries, 0)),
      exits: Math.max(0, asNumber(stats?.exits, 0)),
      lastTradeAt: stats?.last_trade_at
        ? new Date(asNumber(stats.last_trade_at)).toISOString()
        : null,
      deviationPct: null,
      isOutlier: false,
    });
  }

  const bySystem = new Map<string, number[]>();
  for (const row of rows) {
    const key = row.publishedSystem || 'unknown';
    const list = bySystem.get(key) || [];
    list.push(row.tradesCount);
    bySystem.set(key, list);
  }

  const medianOf = (values: number[]): number => {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[mid - 1] + sorted[mid]) / 2
      : sorted[mid];
  };

  let globalMedian = 0;
  const medians = Array.from(bySystem.values()).map(medianOf).filter((v) => v > 0);
  if (medians.length > 0) {
    globalMedian = medianOf(medians);
  } else {
    globalMedian = medianOf(rows.map((r) => r.tradesCount));
  }

  for (const row of rows) {
    const systemList = bySystem.get(row.publishedSystem || 'unknown') || [];
    const systemMedian = medianOf(systemList);
    const baseline = systemMedian > 0 ? systemMedian : globalMedian;
    if (baseline <= 0) {
      row.deviationPct = row.tradesCount > 0 ? 100 : 0;
    } else {
      row.deviationPct = Math.round(((row.tradesCount - baseline) / baseline) * 100);
    }
    row.isOutlier = baseline > 0
      ? row.tradesCount < baseline * 0.2 || row.tradesCount > baseline * 2.5
      : false;
  }

  const outliers = rows.filter((r) => r.isOutlier && r.apiKeyName);

  return {
    periodHours: hours,
    generatedAt: new Date().toISOString(),
    systemMedian: globalMedian,
    rows: rows.sort((a, b) => b.tradesCount - a.tradesCount),
    outliers,
  };
};

export const buildPartnerTradesTelegramDigest = async (periodHours = 6): Promise<string> => {
  const summary = await getPartnerTradesSummary(periodHours);
  const lines = [
    `📊 <b>Partner trades ${summary.periodHours}h</b>`,
    `Медиана по системам: <b>${summary.systemMedian}</b> сделок`,
    `Клиентов: ${summary.rows.length}, активных с сделками: ${summary.rows.filter((r) => r.tradesCount > 0).length}`,
  ];

  if (summary.outliers.length > 0) {
    lines.push('', '⚠️ <b>Отклонения:</b>');
    for (const row of summary.outliers.slice(0, 12)) {
      const sign = (row.deviationPct ?? 0) >= 0 ? '+' : '';
      lines.push(
        `• ${row.displayName}: <b>${row.tradesCount}</b> (${sign}${row.deviationPct}% vs median)`,
      );
    }
  } else {
    lines.push('', '✅ Сильных отклонений нет');
  }

  const top = summary.rows.filter((r) => r.tradesCount > 0).slice(0, 8);
  if (top.length > 0) {
    lines.push('', '<b>Топ активность:</b>');
    for (const row of top) {
      lines.push(`• ${row.displayName}: ${row.tradesCount} (in ${row.entries} / out ${row.exits})`);
    }
  }

  return lines.join('\n');
};

import { runMonitoringCycleForApiKeys } from '../automation/scheduler';
import {
  getMonitoringBundle,
  getMonitoringLatest,
} from '../bot/monitoring';
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
  requestedEnabled: boolean;
};

type ClosedPnlStats = {
  closedCount: number;
  avgPnlPercent: number | null;
  totalPnlUsd: number;
  winRatePercent: number | null;
};

const computeClosedPnlForApiKey = async (apiKeyName: string, sinceMs: number): Promise<ClosedPnlStats> => {
  const strategies = await db.all<{ id?: number }>(
    `SELECT s.id
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?`,
    [apiKeyName],
  ).catch(() => []) as Array<{ id?: number }>;
  const strategyIds = strategies.map((row) => asNumber(row.id, 0)).filter((id) => id > 0);
  if (strategyIds.length === 0) {
    return { closedCount: 0, avgPnlPercent: null, totalPnlUsd: 0, winRatePercent: null };
  }

  const events = await db.all(
    `SELECT strategy_id, trade_type, side, entry_price, position_size, actual_price, actual_time, actual_fee, source_symbol
     FROM live_trade_events
     WHERE strategy_id IN (${strategyIds.map(() => '?').join(',')})
       AND actual_time >= ?
       AND COALESCE(event_origin, CASE WHEN COALESCE(source_trade_id, '') <> '' OR COALESCE(source_order_id, '') <> '' OR ABS(COALESCE(actual_fee, 0)) > 0 THEN 'exchange_fill' ELSE 'strategy_signal' END) = 'exchange_fill'
     ORDER BY actual_time ASC, id ASC`,
    [...strategyIds, sinceMs],
  ).catch(() => []) as Array<Record<string, unknown>>;

  const openByKey = new Map<string, Array<Record<string, unknown>>>();
  const pnlPercents: number[] = [];
  let totalPnlUsd = 0;
  let wins = 0;

  for (const event of events) {
    const strategyId = asNumber(event.strategy_id, 0);
    if (strategyId <= 0) continue;
    const side = asString(event.side, '').toLowerCase();
    const symbol = asString(event.source_symbol, '');
    const key = `${strategyId}|${side}|${symbol}`;
    const tradeType = asString(event.trade_type, '').toLowerCase();

    if (tradeType === 'entry') {
      const list = openByKey.get(key) || [];
      list.push(event);
      openByKey.set(key, list);
      continue;
    }
    if (tradeType !== 'exit') continue;

    const list = openByKey.get(key) || [];
    const entry = list.shift();
    openByKey.set(key, list);
    if (!entry) continue;

    const qty = Math.max(0, asNumber(event.position_size, asNumber(entry.position_size, 0)));
    const entryPrice = asNumber(entry.actual_price, asNumber(entry.entry_price, 0));
    const exitPrice = asNumber(event.actual_price, 0);
    if (qty <= 0 || entryPrice <= 0 || exitPrice <= 0) continue;

    const entryFee = asNumber(entry.actual_fee, 0);
    const exitFee = asNumber(event.actual_fee, 0);
    const gross = side === 'short'
      ? (entryPrice - exitPrice) * qty
      : (exitPrice - entryPrice) * qty;
    const pnl = gross - entryFee - exitFee;
    const notional = entryPrice * qty;
    if (notional <= 0) continue;

    totalPnlUsd += pnl;
    pnlPercents.push((pnl / notional) * 100);
    if (pnl > 0) wins += 1;
  }

  const closedCount = pnlPercents.length;
  const avgPnlPercent = closedCount > 0
    ? Number((pnlPercents.reduce((sum, v) => sum + v, 0) / closedCount).toFixed(3))
    : null;

  return {
    closedCount,
    avgPnlPercent,
    totalPnlUsd: Number(totalPnlUsd.toFixed(4)),
    winRatePercent: closedCount > 0 ? Number(((wins / closedCount) * 100).toFixed(1)) : null,
  };
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
      requestedEnabled: asNumber(row.requested_enabled, 1) === 1,
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
  const tsExpected = row.publishedSystem.includes('v4-2') || row.publishedSystem.includes('v4-4') || row.publishedSystem.includes('b3') ? 20 : 0;
  const monitoring = row.apiKeyName
    ? await getMonitoringLatest(row.apiKeyName).catch(() => null)
    : null;
  const recordedAt = monitoring ? asString(monitoring.recorded_at) : '';

  let lastTradeAt: string | null = null;
  let trades24h = 0;
  if (row.apiKeyName) {
    const tradeRow = await db.get<{ last_trade_at?: number; trades_24h?: number }>(
      `SELECT MAX(lte.actual_time) AS last_trade_at,
              SUM(CASE WHEN lte.actual_time >= ? THEN 1 ELSE 0 END) AS trades_24h
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ?`,
      [Date.now() - 86_400_000, row.apiKeyName],
    ).catch(() => null);
    lastTradeAt = tradeRow?.last_trade_at
      ? new Date(asNumber(tradeRow.last_trade_at)).toISOString()
      : null;
    trades24h = Math.max(0, asNumber(tradeRow?.trades_24h, 0));
  }

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
    lastTradeAt,
    trades24h,
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
  options?: { days?: number; limit?: number; all?: boolean; includeTradesRows?: boolean },
) => {
  const days = asNumber(options?.days, 0);
  const limit = asNumber(options?.limit, 288);
  const allPeriod = options?.all === true;
  const includeTradesRows = options?.includeTradesRows === true;
  return getMonitoringBundle(apiKeyName, {
    days,
    limit,
    all: allPeriod,
    includeTrades: true,
    includeTradesRows,
    includeTradeMarkers: false,
  });
};

export type PartnerTradeSummaryRow = {
  slug: string;
  displayName: string;
  apiKeyName: string;
  publishedSystem: string;
  enabled: boolean;
  requestedEnabled: boolean;
  tradesCount: number;
  entries: number;
  exits: number;
  closedCount: number;
  avgPnlPercent: number | null;
  totalPnlUsd: number;
  equityDeltaUsd: number;
  lastTradeAt: string | null;
  deviationPct: number | null;
  isOutlier: boolean;
};

export type PartnerTsCardSummary = {
  cardKey: string;
  displayLabel: string;
  clients: number;
  activeClients: number;
  tradesMedian: number;
  equityDeltaUsd: number;
  closedTrades: number;
  avgPnlPercent: number | null;
  totalPnlUsd: number;
  zeroTradeClients: string[];
};

const partnerTsCardLabel = (publishedSystem: string): { key: string; label: string } => {
  const ts = String(publishedSystem || '').toLowerCase();
  if (ts.includes('synth-stable') || ts.includes('b3-jul2026')) {
    return { key: 'b3-synth-stable', label: 'B3 synth-stable' };
  }
  if (ts.includes('tv-momentum') || ts.includes('l400')) {
    return { key: 'tv-l400', label: 'TV L400 momentum' };
  }
  const short = String(publishedSystem || 'unknown').split('::').pop() || 'unknown';
  return { key: short.slice(0, 48), label: short.slice(0, 40) };
};

const medianOfValues = (values: number[]): number => {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];
};

const buildPartnerTsCardSummaries = (rows: PartnerTradeSummaryRow[]): PartnerTsCardSummary[] => {
  const groups = new Map<string, PartnerTradeSummaryRow[]>();
  for (const row of rows) {
    if (!row.requestedEnabled || !row.enabled) continue;
    const { key } = partnerTsCardLabel(row.publishedSystem);
    const list = groups.get(key) || [];
    list.push(row);
    groups.set(key, list);
  }

  const out: PartnerTsCardSummary[] = [];
  for (const [, group] of groups) {
    const { label } = partnerTsCardLabel(group[0]?.publishedSystem || '');
    const tradeCounts = group.map((r) => r.tradesCount);
    const closedTrades = group.reduce((sum, r) => sum + r.closedCount, 0);
    const totalPnlUsd = group.reduce((sum, r) => sum + r.totalPnlUsd, 0);
    const equityDeltaUsd = group.reduce((sum, r) => sum + r.equityDeltaUsd, 0);
    const pnlPercents = group
      .map((r) => r.avgPnlPercent)
      .filter((v): v is number => v !== null && Number.isFinite(v));
    const avgPnlPercent = pnlPercents.length > 0
      ? Number((pnlPercents.reduce((sum, v) => sum + v, 0) / pnlPercents.length).toFixed(3))
      : null;
    out.push({
      cardKey: partnerTsCardLabel(group[0]?.publishedSystem || '').key,
      displayLabel: label,
      clients: group.length,
      activeClients: group.filter((r) => r.tradesCount > 0).length,
      tradesMedian: medianOfValues(tradeCounts),
      equityDeltaUsd: Number(equityDeltaUsd.toFixed(2)),
      closedTrades,
      avgPnlPercent,
      totalPnlUsd: Number(totalPnlUsd.toFixed(2)),
      zeroTradeClients: group.filter((r) => r.tradesCount === 0).map((r) => r.displayName),
    });
  }

  return out.sort((a, b) => b.clients - a.clients);
};

export const getPartnerTradesSummary = async (periodHours = 6): Promise<{
  periodHours: number;
  generatedAt: string;
  systemMedian: number;
  totals: {
    clients: number;
    withTrades: number;
    trades: number;
    entries: number;
    exits: number;
    closedTrades: number;
    avgPnlPercent: number | null;
    totalPnlUsd: number;
  };
  rows: PartnerTradeSummaryRow[];
  outliers: PartnerTradeSummaryRow[];
  cards: PartnerTsCardSummary[];
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
        enabled: client.enabled,
        requestedEnabled: client.requestedEnabled,
        tradesCount: 0,
        entries: 0,
        exits: 0,
        closedCount: 0,
        avgPnlPercent: null,
        totalPnlUsd: 0,
        equityDeltaUsd: 0,
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
    const pnl = await computeClosedPnlForApiKey(client.apiKeyName, sinceMs);
    const eqRow = await db.get<{ equity_start?: number; equity_now?: number }>(
      `SELECT
         (SELECT equity_usd FROM monitoring_snapshots ms
          JOIN api_keys a ON a.id = ms.api_key_id
          WHERE a.name = ? AND ms.recorded_at >= datetime('now', ?)
          ORDER BY ms.recorded_at ASC LIMIT 1) AS equity_start,
         (SELECT equity_usd FROM monitoring_snapshots ms
          JOIN api_keys a ON a.id = ms.api_key_id
          WHERE a.name = ?
          ORDER BY ms.recorded_at DESC LIMIT 1) AS equity_now`,
      [client.apiKeyName, `-${hours} hours`, client.apiKeyName],
    ).catch(() => null);
    const equityDeltaUsd = eqRow
      ? asNumber(eqRow.equity_now, 0) - asNumber(eqRow.equity_start, asNumber(eqRow.equity_now, 0))
      : 0;
    rows.push({
      slug: client.slug,
      displayName: client.displayName,
      apiKeyName: client.apiKeyName,
      publishedSystem: client.publishedSystem,
      enabled: client.enabled,
      requestedEnabled: client.requestedEnabled,
      tradesCount,
      entries: Math.max(0, asNumber(stats?.entries, 0)),
      exits: Math.max(0, asNumber(stats?.exits, 0)),
      closedCount: pnl.closedCount,
      avgPnlPercent: pnl.avgPnlPercent,
      totalPnlUsd: pnl.totalPnlUsd,
      equityDeltaUsd: Number(equityDeltaUsd.toFixed(2)),
      lastTradeAt: stats?.last_trade_at
        ? new Date(asNumber(stats.last_trade_at)).toISOString()
        : null,
      deviationPct: null,
      isOutlier: false,
    });
  }

  const bySystem = new Map<string, number[]>();
  for (const row of rows) {
    if (!row.requestedEnabled || !row.enabled) continue;
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
    row.isOutlier = row.requestedEnabled && row.enabled && baseline > 0
      ? row.tradesCount < baseline * 0.2 || row.tradesCount > baseline * 2.5
      : false;
  }

  const outliers = rows.filter((r) => r.isOutlier && r.apiKeyName);
  const closedPnlPercents = rows
    .map((r) => r.avgPnlPercent)
    .filter((v): v is number => v !== null && Number.isFinite(v));
  const globalAvgPnlPercent = closedPnlPercents.length > 0
    ? Number((closedPnlPercents.reduce((sum, v) => sum + v, 0) / closedPnlPercents.length).toFixed(3))
    : null;

  return {
    periodHours: hours,
    generatedAt: new Date().toISOString(),
    systemMedian: globalMedian,
    totals: {
      clients: rows.length,
      withTrades: rows.filter((r) => r.tradesCount > 0).length,
      trades: rows.reduce((sum, r) => sum + r.tradesCount, 0),
      entries: rows.reduce((sum, r) => sum + r.entries, 0),
      exits: rows.reduce((sum, r) => sum + r.exits, 0),
      closedTrades: rows.reduce((sum, r) => sum + r.closedCount, 0),
      avgPnlPercent: globalAvgPnlPercent,
      totalPnlUsd: Number(rows.reduce((sum, r) => sum + r.totalPnlUsd, 0).toFixed(2)),
    },
    rows: rows.sort((a, b) => b.tradesCount - a.tradesCount),
    outliers,
    cards: buildPartnerTsCardSummaries(rows),
  };
};

export const buildPartnerTradesTelegramDigest = async (periodHours = 6): Promise<string> => {
  const summary = await getPartnerTradesSummary(periodHours);
  const pnlLine = summary.totals.closedTrades > 0 && summary.totals.avgPnlPercent !== null
    ? ` · закрыто ${summary.totals.closedTrades}, ср. ${summary.totals.avgPnlPercent >= 0 ? '+' : ''}${summary.totals.avgPnlPercent}%/сделку, Σ $${summary.totals.totalPnlUsd}`
    : '';
  const disabledCount = summary.rows.filter((r) => !r.requestedEnabled || !r.enabled).length;
  const lines = [
    `📊 <b>Partner trades ${summary.periodHours}h</b>`,
    `Медиана по системам: <b>${summary.systemMedian}</b> сделок${pnlLine}`,
    `Клиентов: ${summary.rows.length}, активных с сделками: ${summary.rows.filter((r) => r.tradesCount > 0).length}${disabledCount > 0 ? `, выкл: ${disabledCount}` : ''}`,
  ];

  if (summary.cards.length > 0) {
    lines.push('', '<b>По карточкам ТС:</b>');
    for (const card of summary.cards) {
      const deltaSign = card.equityDeltaUsd >= 0 ? '+' : '';
      const pnlPart = card.closedTrades > 0 && card.avgPnlPercent !== null
        ? ` · закр ${card.closedTrades}, ср ${card.avgPnlPercent >= 0 ? '+' : ''}${card.avgPnlPercent}%/сд, Σ $${card.totalPnlUsd}`
        : '';
      lines.push(
        `• <b>${card.displayLabel}</b>: ${card.activeClients}/${card.clients} акт · мед ${card.tradesMedian} · Δ${summary.periodHours}h ${deltaSign}$${card.equityDeltaUsd}${pnlPart}`,
      );
      if (card.zeroTradeClients.length > 0) {
        lines.push(`  без сделок: ${card.zeroTradeClients.slice(0, 6).join(', ')}`);
      }
    }
  }

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
      const pnlSuffix = row.closedCount > 0 && row.avgPnlPercent !== null
        ? ` · ${row.avgPnlPercent >= 0 ? '+' : ''}${row.avgPnlPercent}%/сд`
        : '';
      lines.push(`• ${row.displayName}: ${row.tradesCount} (in ${row.entries} / out ${row.exits})${pnlSuffix}`);
    }
  }

  return lines.join('\n');
};

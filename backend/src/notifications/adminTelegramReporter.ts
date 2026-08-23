import { db } from '../utils/database';
import logger from '../utils/logger';

type ReporterState = {
  lastReportAtMs: number;
  lastLoginAtIso: string;
};

type ReportNowOptions = {
  periodHours?: number;
  includeLoginAlerts?: boolean;
  runtimeOnly?: boolean;
  format?: 'short' | 'full' | 'verbose';
};

const toFinite = (value: unknown, fallback = 0): number => {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
};

const isEnabled = (): boolean => {
  return Boolean(process.env.TELEGRAM_ADMIN_BOT_TOKEN && process.env.TELEGRAM_ADMIN_CHAT_ID);
};

const isAdminReporterEnabledInDb = async (): Promise<boolean> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['telegram.admin.enabled']);
  const value = String(row?.value || '').trim();
  if (!value) {
    return true;
  }
  return value !== '0';
};

const getReportIntervalMinutesFromDb = async (): Promise<number> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['telegram.admin.report_interval_minutes']);
  const raw = String(row?.value || '').trim();
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 5 ? Math.min(1440, parsed) : 1440;
};

const isRuntimeOnlyEnabledInDb = async (): Promise<boolean> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['telegram.admin.runtimeonly']);
  const value = String(row?.value || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
};

const isSectionEnabled = async (section: 'accounts' | 'drift' | 'lowlot'): Promise<boolean> => {
  const key = `telegram.admin.section.${section}`;
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [key]);
  const value = String(row?.value || '').trim().toLowerCase();
  if (!value) return true; // enabled by default
  return value !== '0' && value !== 'false' && value !== 'no' && value !== 'off';
};

const escapeHtml = (value: string): string => {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
};

const sendTelegramMessage = async (text: string): Promise<void> => {
  const token = String(process.env.TELEGRAM_ADMIN_BOT_TOKEN || '').trim();
  const chatId = String(process.env.TELEGRAM_ADMIN_CHAT_ID || '').trim();
  if (!token || !chatId) {
    return;
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Telegram send failed: ${response.status} ${body}`);
  }
};

const getLatestLoginAtIso = async (): Promise<string> => {
  const row = await db.get('SELECT MAX(last_login_at) AS max_login FROM client_users');
  return String(row?.max_login || '').trim();
};

const shorten = (value: string, max = 140): string => {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  if (normalized.length <= max) {
    return normalized;
  }
  return `${normalized.slice(0, Math.max(0, max - 1))}...`;
};

const buildLowLotActionHint = (maxDeposit: number, lotPercent: number): string => {
  const safeDeposit = Math.max(0, maxDeposit);
  const safeLot = Math.max(0, lotPercent);

  const targetLot = safeLot < 40 ? 50 : Math.min(100, safeLot + 20);
  const recommendedDeposit = Math.max(150, safeDeposit * 1.5);

  return `action: dep>=${recommendedDeposit.toFixed(0)} or lot>=${targetLot.toFixed(0)}% or replace pair via sweep`;
};

const buildDriftHumanHint = (metricName: string, value: number, threshold: number): string => {
  const metric = String(metricName || '').toLowerCase();
  if (metric === 'win_rate_drop') {
    return `win-rate live ${Math.max(0, value * 100).toFixed(1)}% vs ref ${Math.max(0, threshold * 100).toFixed(1)}%`;
  }
  if (metric === 'pnl_drop') {
    return `PnL gap ${Math.abs(value * 100).toFixed(1)}% (allowed ${Math.abs(threshold * 100).toFixed(1)}%)`;
  }
  if (metric === 'entry_price_deviation') {
    return `entry deviation ${Math.abs(value).toFixed(2)}% vs limit ${Math.abs(threshold).toFixed(2)}%`;
  }
  if (metric === 'slippage_drift') {
    return `slippage ${Math.abs(value).toFixed(2)}% vs limit ${Math.abs(threshold).toFixed(2)}%`;
  }
  return `value ${value.toFixed(4)} vs threshold ${threshold.toFixed(4)}`;
};

const formatDriftPercent = (value: number): string => {
  const drift = toFinite(value, 0);
  if (Math.abs(drift) >= 500) {
    return `${drift >= 0 ? '>=' : '<='}500%`;
  }
  return `${drift.toFixed(1)}%`;
};

const getFreshAlertWindowHours = (periodHours: number): number => {
  const configured = Math.max(1, Math.floor(Number(process.env.TELEGRAM_ADMIN_ALERT_FRESH_HOURS || 24) || 24));
  return Math.max(1, Math.min(Math.floor(periodHours), configured));
};

const buildRuntimeClientLines = async (periodHours: number): Promise<string[]> => {
  const rows = await db.all(
    `WITH active_clients AS (
       SELECT
         'algofund' AS mode,
         ap.id AS profile_id,
         t.display_name AS display_name,
         t.slug AS tenant_slug,
         COALESCE(NULLIF(ap.execution_api_key_name, ''), NULLIF(t.assigned_api_key_name, ''), NULLIF(ap.assigned_api_key_name, '')) AS execution_api_key_name,
         COALESCE(NULLIF(ap.assigned_api_key_name, ''), NULLIF(t.assigned_api_key_name, '')) AS system_api_key_name,
         COALESCE(ap.published_system_name, '') AS system_name,
         COALESCE(ap.risk_multiplier, 1) AS risk_value
       FROM algofund_profiles ap
       JOIN tenants t ON t.id = ap.tenant_id
       WHERE COALESCE(ap.requested_enabled, 0) = 1
         AND (
           COALESCE(ap.actual_enabled, 0) = 1
           OR TRIM(COALESCE(ap.published_system_name, '')) != ''
           OR EXISTS (
             SELECT 1 FROM algofund_active_portfolios aap
             WHERE aap.profile_id = ap.id AND COALESCE(aap.is_enabled, 1) = 1
           )
         )

       UNION ALL

       SELECT
         'strategy' AS mode,
         sp.id AS profile_id,
         t.display_name AS display_name,
         t.slug AS tenant_slug,
         COALESCE(NULLIF(sp.assigned_api_key_name, ''), NULLIF(t.assigned_api_key_name, '')) AS execution_api_key_name,
         '' AS system_api_key_name,
         '' AS system_name,
         0 AS risk_value
       FROM strategy_client_profiles sp
       JOIN tenants t ON t.id = sp.tenant_id
       WHERE COALESCE(sp.requested_enabled, 0) = 1
         AND COALESCE(sp.actual_enabled, 0) = 1
     )
     SELECT
       ac.mode,
       ac.profile_id,
       ac.display_name,
       ac.tenant_slug,
       ac.execution_api_key_name,
       ac.system_api_key_name,
       ac.system_name,
       ac.risk_value,
       COALESCE(ms_latest.equity_usd, 0) AS equity_latest,
       COALESCE(ms_latest.unrealized_pnl, 0) AS unrealized_pnl,
       COALESCE(ms_old.equity_usd, COALESCE(ms_latest.equity_usd, 0)) AS equity_old,
       COALESCE(ms_latest.margin_load_percent, 0) AS margin_load,
       COALESCE(ms_latest.drawdown_percent, 0) AS drawdown,
       CASE
         WHEN ac.mode = 'algofund' THEN COALESCE(tr_algofund.cnt, 0)
         ELSE COALESCE(tr_key.cnt, 0)
       END AS trades_count
     FROM active_clients ac
     LEFT JOIN api_keys a ON a.name = ac.execution_api_key_name
     LEFT JOIN (
       SELECT m1.api_key_id, m1.equity_usd, m1.unrealized_pnl, m1.margin_load_percent, m1.drawdown_percent
       FROM mon.monitoring_snapshots m1
       JOIN (
         SELECT api_key_id, MAX(datetime(recorded_at)) AS max_at
         FROM mon.monitoring_snapshots
         GROUP BY api_key_id
       ) mx ON mx.api_key_id = m1.api_key_id AND datetime(m1.recorded_at) = mx.max_at
     ) ms_latest ON ms_latest.api_key_id = a.id
     LEFT JOIN (
       SELECT m2.api_key_id, m2.equity_usd
       FROM mon.monitoring_snapshots m2
       JOIN (
         SELECT api_key_id, MIN(datetime(recorded_at)) AS min_at
         FROM mon.monitoring_snapshots
         WHERE datetime(recorded_at) >= datetime('now', ?)
         GROUP BY api_key_id
       ) mn ON mn.api_key_id = m2.api_key_id AND datetime(m2.recorded_at) = mn.min_at
     ) ms_old ON ms_old.api_key_id = a.id
     LEFT JOIN (
       SELECT s.api_key_id, COUNT(*) AS cnt
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE lte.actual_time >= (strftime('%s','now', ?) * 1000)
       GROUP BY s.api_key_id
     ) tr_key ON tr_key.api_key_id = a.id
     LEFT JOIN (
       SELECT aas.profile_id, COUNT(*) AS cnt
       FROM algofund_active_systems aas
       JOIN trading_systems ts ON ts.name = aas.system_name
       JOIN trading_system_members tsm ON tsm.system_id = ts.id AND COALESCE(tsm.is_enabled, 1) = 1
       JOIN live_trade_events lte ON lte.strategy_id = tsm.strategy_id
       WHERE COALESCE(aas.is_enabled, 1) = 1
         AND lte.actual_time >= (strftime('%s','now', ?) * 1000)
       GROUP BY aas.profile_id
     ) tr_algofund ON tr_algofund.profile_id = ac.profile_id
     ORDER BY ac.mode ASC, ac.display_name ASC`,
    [`-${periodHours} hours`, `-${periodHours} hours`, `-${periodHours} hours`]
  );

  const out: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const displayName = String(row?.display_name || '').trim();
    const tenantSlug = String(row?.tenant_slug || '').trim();
    const executionApiKeyName = String(row?.execution_api_key_name || '').trim();
    const systemApiKeyName = String(row?.system_api_key_name || '').trim();
    const mode = String(row?.mode || '').trim() || 'client';
    const profileId = Math.max(0, Math.floor(toFinite(row?.profile_id, 0)));
    const systemName = String(row?.system_name || '').trim();

    const eqLatest = toFinite(row?.equity_latest, 0);
  const upnl = toFinite(row?.unrealized_pnl, 0);
    const eqOld = toFinite(row?.equity_old, eqLatest);
    const delta = eqLatest - eqOld;
    const margin = toFinite(row?.margin_load, 0);
    const dd = toFinite(row?.drawdown, 0);
    const trades = Math.max(0, Math.floor(toFinite(row?.trades_count, 0)));

    const warnings: string[] = [];
    if (margin >= 80) {
      warnings.push('HIGH_ML');
    }
    if (dd >= 35) {
      warnings.push('HIGH_DD');
    }

    const scopePart = systemName
      ? ` | ts=${escapeHtml(shorten(systemName, 54))}`
      : '';
    const keyPart = `key=${escapeHtml(executionApiKeyName || '-')}`;

    out.push(
      [
        `• ${escapeHtml(displayName || tenantSlug || executionApiKeyName || 'client')} (${escapeHtml(mode)}#${profileId})`,
        `  ключ: ${escapeHtml(executionApiKeyName || '-')}`,
        systemName ? `  TS: ${escapeHtml(shorten(systemName, 72))}` : '',
        `  сделки: ${trades} | equity: ${eqLatest.toFixed(2)} | uPnL: ${upnl.toFixed(2)}`,
        `  delta: ${delta.toFixed(2)} | margin: ${margin.toFixed(1)}% | DD: ${dd.toFixed(1)}%${warnings.length ? ` | риски: ${warnings.join(',')}` : ''}`,
      ].filter(Boolean).join('\n')
    );
  }

  return out;
};

const buildAccountLines = async (periodHours: number, runtimeOnly = false): Promise<string[]> => {
  if (runtimeOnly) {
    return buildRuntimeClientLines(periodHours);
  }

  const runtimeFilter = runtimeOnly
    ? `AND a.name IN (
         SELECT DISTINCT api_key_name
         FROM (
           SELECT COALESCE(NULLIF(ap.execution_api_key_name, ''), NULLIF(t.assigned_api_key_name, ''), NULLIF(ap.assigned_api_key_name, '')) AS api_key_name
           FROM algofund_profiles ap
           JOIN tenants t ON t.id = ap.tenant_id
           WHERE COALESCE(ap.requested_enabled, 0) = 1
             AND COALESCE(ap.actual_enabled, 0) = 1

           UNION

           SELECT COALESCE(NULLIF(sp.assigned_api_key_name, ''), NULLIF(t.assigned_api_key_name, '')) AS api_key_name
           FROM strategy_client_profiles sp
           JOIN tenants t ON t.id = sp.tenant_id
           WHERE COALESCE(sp.requested_enabled, 0) = 1
             AND COALESCE(sp.actual_enabled, 0) = 1
         ) active_clients
         WHERE COALESCE(api_key_name, '') <> ''
       )`
    : '';
  const rows = await db.all(
    `SELECT
       a.name AS api_key_name,
       COALESCE(ms_latest.equity_usd, 0) AS equity_latest,
       COALESCE(ms_latest.unrealized_pnl, 0) AS unrealized_pnl,
       COALESCE(ms_old.equity_usd, COALESCE(ms_latest.equity_usd, 0)) AS equity_old,
       COALESCE(ms_latest.margin_load_percent, 0) AS margin_load,
       COALESCE(ms_latest.drawdown_percent, 0) AS drawdown,
       COALESCE(tr.cnt, 0) AS trades_count
     FROM api_keys a
     LEFT JOIN (
       SELECT m1.api_key_id, m1.equity_usd, m1.unrealized_pnl, m1.margin_load_percent, m1.drawdown_percent
       FROM mon.monitoring_snapshots m1
       JOIN (
         SELECT api_key_id, MAX(datetime(recorded_at)) AS max_at
         FROM mon.monitoring_snapshots
         GROUP BY api_key_id
       ) mx ON mx.api_key_id = m1.api_key_id AND datetime(m1.recorded_at) = mx.max_at
     ) ms_latest ON ms_latest.api_key_id = a.id
     LEFT JOIN (
       SELECT m2.api_key_id, m2.equity_usd
       FROM mon.monitoring_snapshots m2
       JOIN (
         SELECT api_key_id, MIN(datetime(recorded_at)) AS min_at
         FROM mon.monitoring_snapshots
         WHERE datetime(recorded_at) >= datetime('now', ?)
         GROUP BY api_key_id
       ) mn ON mn.api_key_id = m2.api_key_id AND datetime(m2.recorded_at) = mn.min_at
     ) ms_old ON ms_old.api_key_id = a.id
     LEFT JOIN (
       SELECT s.api_key_id, COUNT(*) AS cnt
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       WHERE lte.actual_time >= (strftime('%s','now', ?) * 1000)
       GROUP BY s.api_key_id
     ) tr ON tr.api_key_id = a.id
     WHERE 1=1 ${runtimeFilter}
     ORDER BY a.name ASC`,
    [`-${periodHours} hours`, `-${periodHours} hours`]
  );

  const out: string[] = [];
  for (const row of Array.isArray(rows) ? rows : []) {
    const apiKeyName = String(row?.api_key_name || '').trim();
    if (!apiKeyName) {
      continue;
    }

    const eqLatest = toFinite(row?.equity_latest, 0);
  const upnl = toFinite(row?.unrealized_pnl, 0);
    const eqOld = toFinite(row?.equity_old, eqLatest);
    const delta = eqLatest - eqOld;
    const margin = toFinite(row?.margin_load, 0);
    const dd = toFinite(row?.drawdown, 0);
    const trades = Math.max(0, Math.floor(toFinite(row?.trades_count, 0)));

    const warnings: string[] = [];
    if (margin >= 80) {
      warnings.push('HIGH_ML');
    }
    if (dd >= 35) {
      warnings.push('HIGH_DD');
    }

    out.push(
      `• ${escapeHtml(apiKeyName)}: сделки=${trades}, equity=${eqLatest.toFixed(2)}, uPnL=${upnl.toFixed(2)}, delta=${delta.toFixed(2)}, margin=${margin.toFixed(1)}%, DD=${dd.toFixed(1)}%${warnings.length ? `, риски=${warnings.join(',')}` : ''}`
    );
  }

  return out;
};

const buildDriftAlertLines = async (periodHours: number, limit = 8): Promise<string[]> => {
  const freshHours = getFreshAlertWindowHours(periodHours);
  const rows = await db.all(
    `WITH ranked AS (
       SELECT
         a.name AS api_key_name,
         s.id AS strategy_id,
         s.name AS strategy_name,
         da.metric_name,
         da.severity,
         da.drift_percent,
         da.value,
         da.threshold,
         da.description,
         da.created_at,
         ROW_NUMBER() OVER (
           PARTITION BY a.name, s.id, COALESCE(da.metric_name, '')
           ORDER BY da.created_at DESC
         ) AS rn
       FROM drift_alerts da
       JOIN strategies s ON s.id = da.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE da.created_at >= (strftime('%s', 'now', ?) * 1000)
         AND COALESCE(s.is_active, 0) = 1
         AND datetime(COALESCE(s.updated_at, '1970-01-01 00:00:00')) >= datetime('now', ?)
     )
     SELECT
       api_key_name,
       strategy_id,
       strategy_name,
       metric_name,
       severity,
       drift_percent,
       value,
       threshold,
       description,
       created_at
     FROM ranked
     WHERE rn = 1
     ORDER BY created_at DESC
     LIMIT ?`,
    [`-${freshHours} hours`, `-${freshHours} hours`, Math.max(1, Math.floor(limit))]
  );

  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const apiKey = escapeHtml(String(row?.api_key_name || ''));
    const strategyId = Math.max(0, Math.floor(toFinite(row?.strategy_id, 0)));
    const strategyName = escapeHtml(shorten(String(row?.strategy_name || ''), 40));
    const metric = escapeHtml(String(row?.metric_name || 'metric'));
    const metricRaw = String(row?.metric_name || 'metric');
    const severity = String(row?.severity || 'warning').toLowerCase() === 'critical' ? 'critical' : 'warning';
    const drift = toFinite(row?.drift_percent, 0);
    const value = toFinite(row?.value, 0);
    const threshold = toFinite(row?.threshold, 0);
    const description = escapeHtml(shorten(String(row?.description || ''), 120));
    const hint = escapeHtml(buildDriftHumanHint(metricRaw, value, threshold));
    return `${apiKey} | S#${strategyId} ${strategyName} | ${severity.toUpperCase()} ${metric} drift=${formatDriftPercent(drift)} | ${hint} | ${description}`;
  });
};

const buildLowLotLines = async (periodHours: number, limit = 8): Promise<string[]> => {
  const freshHours = getFreshAlertWindowHours(periodHours);
  const rows = await db.all(
    `WITH ranked AS (
       SELECT
         a.name AS api_key_name,
         s.id AS strategy_id,
         s.name AS strategy_name,
         s.base_symbol,
         s.quote_symbol,
         e.message AS last_error,
         s.max_deposit,
         s.leverage,
         s.lot_long_percent,
         s.lot_short_percent,
         datetime(e.created_at / 1000, 'unixepoch') AS updated_at,
         e.event_type,
         e.resolved_at,
         e.created_at,
         ROW_NUMBER() OVER (
           PARTITION BY a.name, s.id
           ORDER BY e.created_at DESC
         ) AS rn
       FROM strategy_runtime_events e
       JOIN strategies s ON s.id = e.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE e.created_at >= (strftime('%s', 'now', ?) * 1000)
         AND COALESCE(s.is_active, 0) = 1
         AND lower(COALESCE(s.last_error, '')) LIKE '%order size too small%'
     )
     SELECT
       api_key_name,
       strategy_id,
       strategy_name,
       base_symbol,
       quote_symbol,
       last_error,
       max_deposit,
       leverage,
       lot_long_percent,
       lot_short_percent,
       updated_at
     FROM ranked
     WHERE rn = 1
       AND event_type = 'low_lot_error'
       AND resolved_at = 0
     ORDER BY created_at DESC
     LIMIT ?`,
    [`-${freshHours} hours`, Math.max(1, Math.floor(limit))]
  );

  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const apiKey = escapeHtml(String(row?.api_key_name || ''));
    const strategyId = Math.max(0, Math.floor(toFinite(row?.strategy_id, 0)));
    const strategyName = escapeHtml(shorten(String(row?.strategy_name || ''), 40));
    const baseSymbol = String(row?.base_symbol || '').toUpperCase();
    const quoteSymbol = String(row?.quote_symbol || '').toUpperCase();
    const pair = quoteSymbol ? `${baseSymbol}/${quoteSymbol}` : baseSymbol;
    const maxDeposit = Math.max(0, toFinite(row?.max_deposit, 0));
    const leverage = Math.max(0, toFinite(row?.leverage, 0));
    const lotLong = Math.max(0, toFinite(row?.lot_long_percent, 0));
    const lotShort = Math.max(0, toFinite(row?.lot_short_percent, 0));
    const err = escapeHtml(shorten(String(row?.last_error || ''), 120));
    const lot = Math.max(lotLong, lotShort);
    const hint = escapeHtml(buildLowLotActionHint(maxDeposit, lot));
    return `${apiKey} | S#${strategyId} ${strategyName} ${escapeHtml(pair)} | dep=${maxDeposit.toFixed(0)} lev=${leverage.toFixed(1)} lot=${lot.toFixed(1)}% | ${err} | ${hint}`;
  });
};

const trimTelegramText = (value: string, maxLen = 3900): string => {
  const text = String(value || '');
  if (text.length <= maxLen) {
    return text;
  }

  return `${text.slice(0, Math.max(0, maxLen - 21))}\n...message truncated`;
};

// ── Health summary (default periodic report) ────────────────────────────────

/** Demo copy-trading fleet — report AUM separately from client books. */
const COPY_TRADING_API_KEYS = new Set(['icopy1-api', 'arcopy1', 'Copy_Alex1']);

type HealthRow = {
  display_name: string | null;
  tenant_slug: string | null;
  api_key_name: string | null;
  system_name: string | null;
  exchange: string;
  actual_enabled: boolean;
  equity: number;
  equity_start: number;
  equity_delta: number;
  upnl: number;
  margin: number;
  dd: number;
  recorded_at: string | null;
  snap_count: number;
  trades_period: number;
  fills_period: number;
  volume_period: number;
  exchange_fills_24h: number;
  signals_24h: number;
  last_error: string | null;
};

const fetchDuplicateSidGroupsByApiKey = async (apiKeyNames: string[]): Promise<Map<string, number>> => {
  const names = Array.from(new Set(apiKeyNames.map((v) => String(v || '').trim()).filter(Boolean)));
  if (names.length === 0) {
    return new Map<string, number>();
  }
  const placeholders = names.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT api_key_name, COUNT(*) AS dup_groups
     FROM (
       SELECT
         a.name AS api_key_name,
         substr(s.name, instr(s.name, '::SID') + 5) AS source_sid,
         COUNT(*) AS cnt
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE s.is_active = 1
         AND instr(s.name, '::SID') > 0
         AND a.name IN (${placeholders})
       GROUP BY a.name, source_sid
       HAVING cnt > 1
     ) d
     GROUP BY api_key_name`,
    names,
  ) as Array<{ api_key_name: string; dup_groups: number }>;
  const out = new Map<string, number>();
  for (const row of rows || []) {
    out.set(String(row.api_key_name || ''), Math.max(0, Math.floor(toFinite(row.dup_groups, 0))));
  }
  return out;
};

const parseSqliteUtc = (value: string | null): number | null => {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const ms = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T') + 'Z');
  return Number.isFinite(ms) ? ms : null;
};

const fetchHealthRows = async (periodHours: number): Promise<HealthRow[]> => {
  const rows = await db.all(
    `SELECT
       t.display_name,
       t.slug AS tenant_slug,
       COALESCE(NULLIF(ap.execution_api_key_name,''), NULLIF(t.assigned_api_key_name,''), NULLIF(ap.assigned_api_key_name,'')) AS api_key_name,
       COALESCE(ap.published_system_name,'') AS system_name,
       COALESCE(NULLIF(LOWER(a.exchange), ''), 'unknown') AS exchange,
       COALESCE(ap.actual_enabled,0) AS actual_enabled,
       COALESCE(ms.equity_usd,0)            AS equity,
       COALESCE(ms_start.equity_usd, COALESCE(ms.equity_usd,0)) AS equity_start,
       COALESCE(ms.equity_usd,0) - COALESCE(ms_start.equity_usd, COALESCE(ms.equity_usd,0)) AS equity_delta,
       COALESCE(ms.unrealized_pnl,0)        AS upnl,
       COALESCE(ms.margin_load_percent,0)   AS margin,
       COALESCE(ms.drawdown_percent,0)      AS dd,
       ms.recorded_at                        AS recorded_at,
       -- period-DD: пик берём только из снепшотов с небольшой unrealized-компонентой
       -- (|unrealized_pnl| < 20% equity), чтобы мимолётный котировочный спайк не завышал peak.
       -- Текущее значение — equity_usd как есть, т.к. большой открытый убыток = реальный риск
       -- (margin_load 99% → ликвидация, даже если баланс ещё цел).
       CASE
         WHEN COALESCE(peak.peak_equity,0) > 0
              AND COALESCE(ms.equity_usd,0) < peak.peak_equity
           THEN ROUND((peak.peak_equity - COALESCE(ms.equity_usd,0)) / peak.peak_equity * 100, 2)
         ELSE 0
       END AS period_dd,
       (SELECT COUNT(*) FROM mon.monitoring_snapshots ms2 WHERE ms2.api_key_id = a.id AND datetime(ms2.recorded_at) >= datetime('now', ?)) AS snap_count,
       (SELECT COUNT(*) FROM live_trade_events lte JOIN strategies s ON s.id=lte.strategy_id
         WHERE s.api_key_id = a.id AND lte.actual_time >= (strftime('%s','now', ?) * 1000)) AS trades_period,
       (SELECT COUNT(*) FROM live_trade_events lte JOIN strategies s ON s.id=lte.strategy_id
         WHERE s.api_key_id = a.id
           AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill'
           AND lte.actual_time >= (strftime('%s','now', ?) * 1000)) AS fills_period,
       (SELECT COALESCE(SUM(ABS(COALESCE(lte.actual_price, 0) * COALESCE(lte.position_size, 0))), 0)
          FROM live_trade_events lte JOIN strategies s ON s.id=lte.strategy_id
         WHERE s.api_key_id = a.id
           AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill'
           AND COALESCE(lte.trade_type, '') = 'entry'
           AND lte.actual_time >= (strftime('%s','now', ?) * 1000)) AS volume_period,
       (SELECT COUNT(*) FROM live_trade_events lte JOIN strategies s ON s.id=lte.strategy_id
         WHERE s.api_key_id = a.id
           AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill'
           AND lte.actual_time >= (strftime('%s','now','-24 hours') * 1000)) AS exchange_fills_24h,
       (SELECT COUNT(*) FROM live_trade_events lte JOIN strategies s ON s.id=lte.strategy_id
         WHERE s.api_key_id = a.id
           AND COALESCE(lte.event_origin, 'strategy_signal') = 'strategy_signal'
           AND lte.actual_time >= (strftime('%s','now','-24 hours') * 1000)) AS signals_24h,
       (SELECT s.last_error FROM strategies s
         WHERE s.api_key_id = a.id
           AND COALESCE(s.is_active, 0) = 1
           AND COALESCE(s.last_error, '') != ''
         ORDER BY COALESCE(s.updated_at, '') DESC
         LIMIT 1) AS last_error
     FROM algofund_profiles ap
     JOIN tenants t ON t.id = ap.tenant_id
     LEFT JOIN api_keys a ON a.name = COALESCE(NULLIF(ap.execution_api_key_name,''), NULLIF(t.assigned_api_key_name,''), NULLIF(ap.assigned_api_key_name,''))
     LEFT JOIN (
       SELECT m1.api_key_id, m1.equity_usd, m1.unrealized_pnl, m1.margin_load_percent, m1.drawdown_percent, m1.recorded_at
       FROM mon.monitoring_snapshots m1
       JOIN (SELECT api_key_id, MAX(datetime(recorded_at)) AS mx FROM mon.monitoring_snapshots GROUP BY api_key_id) j
         ON j.api_key_id = m1.api_key_id AND datetime(m1.recorded_at) = j.mx
     ) ms ON ms.api_key_id = a.id
     LEFT JOIN (
       SELECT ms0.api_key_id, ms0.equity_usd
       FROM mon.monitoring_snapshots ms0
       JOIN (
         SELECT api_key_id, MIN(datetime(recorded_at)) AS min_at
         FROM mon.monitoring_snapshots
         WHERE datetime(recorded_at) >= datetime('now', ?)
         GROUP BY api_key_id
       ) mn ON mn.api_key_id = ms0.api_key_id AND datetime(ms0.recorded_at) = mn.min_at
     ) ms_start ON ms_start.api_key_id = a.id
     LEFT JOIN (
       SELECT api_key_id, MAX(equity_usd) AS peak_equity
       FROM mon.monitoring_snapshots
       WHERE datetime(recorded_at) >= datetime('now', ?)
         AND ABS(COALESCE(unrealized_pnl, 0)) < equity_usd * 0.20
       GROUP BY api_key_id
     ) peak ON peak.api_key_id = a.id
     WHERE COALESCE(ap.requested_enabled,0) = 1
       AND (
         COALESCE(ap.actual_enabled,0) = 1
         OR TRIM(COALESCE(ap.published_system_name, '')) != ''
         OR EXISTS (
           SELECT 1 FROM algofund_active_portfolios aap
           WHERE aap.profile_id = ap.id AND COALESCE(aap.is_enabled, 1) = 1
         )
       )
       -- Skip dematerialized profiles: no active TS published AND no live runtime strategies on the key.
       -- This silences margin/drawdown/desync alerts for keys we no longer manage in runtime
       -- (e.g. profiles that were dematerialized but where positions were intentionally kept on the exchange).
       AND (
         COALESCE(ap.published_system_name, '') != ''
         OR EXISTS (
           SELECT 1 FROM strategies s
           WHERE s.api_key_id = a.id
             AND COALESCE(s.is_runtime, 0) = 1
             AND COALESCE(s.is_archived, 0) = 0
         )
         OR EXISTS (
           SELECT 1 FROM algofund_active_portfolios aap
           WHERE aap.profile_id = ap.id AND COALESCE(aap.is_enabled, 1) = 1
         )
       )
     ORDER BY t.display_name ASC`,
    [
      `-${periodHours} hours`,
      `-${periodHours} hours`,
      `-${periodHours} hours`,
      `-${periodHours} hours`,
      `-${periodHours} hours`,
      `-${periodHours} hours`,
    ]
  ) as any[];
  return (rows || []).map((r) => ({
    display_name: r.display_name,
    tenant_slug: r.tenant_slug,
    api_key_name: r.api_key_name,
    system_name: r.system_name,
    exchange: String(r.exchange || 'unknown').trim().toLowerCase() || 'unknown',
    actual_enabled: Number(r.actual_enabled || 0) === 1,
    equity: toFinite(r.equity, 0),
    equity_start: toFinite(r.equity_start, 0),
    equity_delta: toFinite(r.equity_delta, 0),
    upnl: toFinite(r.upnl, 0),
    margin: toFinite(r.margin, 0),
    // Используем ТОЛЬКО period_dd (по equity_usd, пик = только «чистые» снепшоты без котировочных спайков).
    // Биржевой r.dd (drawdown_percent) тоже equity-based но без фильтрации пика — оставляем ему быть fallback.
    dd: Math.max(toFinite(r.period_dd, 0), toFinite(r.dd, 0)),
    recorded_at: r.recorded_at,
    snap_count: Math.max(0, Math.floor(toFinite(r.snap_count, 0))),
    trades_period: Math.max(0, Math.floor(toFinite(r.trades_period, 0))),
    fills_period: Math.max(0, Math.floor(toFinite(r.fills_period, 0))),
    volume_period: Math.max(0, toFinite(r.volume_period, 0)),
    exchange_fills_24h: Math.max(0, Math.floor(toFinite(r.exchange_fills_24h, 0))),
    signals_24h: Math.max(0, Math.floor(toFinite(r.signals_24h, 0))),
    last_error: r.last_error ? String(r.last_error) : null,
  }));
};

const isCopyTradingRow = (row: HealthRow): boolean => {
  const key = String(row.api_key_name || '').trim();
  if (COPY_TRADING_API_KEYS.has(key)) return true;
  const name = String(row.display_name || '').trim().toLowerCase();
  return name === 'icopy1' || name === 'arcopy1' || name === 'acopy1';
};

const formatUsdCompact = (value: number): string => {
  const n = toFinite(value, 0);
  if (Math.abs(n) >= 1000) return `$${n.toFixed(0)}`;
  return `$${n.toFixed(2)}`;
};

const formatSignedUsd = (value: number): string => {
  const n = toFinite(value, 0);
  return `${n >= 0 ? '+' : ''}$${n.toFixed(2)}`;
};

const formatSignedPlain = (value: number): string => {
  const n = toFinite(value, 0);
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}`;
};

const sumRows = (rows: HealthRow[]): {
  n: number;
  equity: number;
  delta: number;
  upnl: number;
  fills: number;
  volume: number;
} => ({
  n: rows.length,
  equity: rows.reduce((s, r) => s + r.equity, 0),
  delta: rows.reduce((s, r) => s + r.equity_delta, 0),
  upnl: rows.reduce((s, r) => s + r.upnl, 0),
  fills: rows.reduce((s, r) => s + r.fills_period, 0),
  volume: rows.reduce((s, r) => s + r.volume_period, 0),
});

const formatAvgFills = (fills: number, n: number): string => {
  if (n <= 0) return '0';
  const avg = fills / n;
  return avg >= 10 ? avg.toFixed(0) : avg.toFixed(1);
};

const formatGroupTotals = (periodHours: number, rows: HealthRow[]): string => {
  const g = sumRows(rows);
  return `${formatUsdCompact(g.equity)} · Δ${periodHours}h: ${formatSignedUsd(g.delta)} · uPnL: ${formatSignedPlain(g.upnl)} · fill ${g.fills} (ср ${formatAvgFills(g.fills, g.n)}) · vol ${formatUsdCompact(g.volume)}`;
};

const formatMemberLine = (row: HealthRow, periodHours: number): string => {
  const name = escapeHtml(String(row.display_name || row.api_key_name || '?'));
  return `  ${name}: ${formatUsdCompact(row.equity)} · Δ${periodHours}h: ${formatSignedUsd(row.equity_delta)} · uPnL: ${formatSignedPlain(row.upnl)}`;
};

const sortByEquityDesc = (rows: HealthRow[]): HealthRow[] =>
  [...rows].sort((a, b) => b.equity - a.equity);

const GROUP_RULE = '────────';

const buildAumBreakdownLines = (statsRows: HealthRow[], periodHours: number): string[] => {
  if (statsRows.length === 0) return [];

  const copyRows = sortByEquityDesc(statsRows.filter(isCopyTradingRow));
  const clientRows = sortByEquityDesc(statsRows.filter((r) => !isCopyTradingRow(r)));

  const byExchange = (): Array<{ ex: string; rows: HealthRow[] }> => {
    const map = new Map<string, HealthRow[]>();
    for (const r of statsRows) {
      const ex = r.exchange || 'unknown';
      const cur = map.get(ex) || [];
      cur.push(r);
      map.set(ex, cur);
    }
    return Array.from(map.entries())
      .map(([ex, rows]) => ({ ex, rows }))
      .sort((a, b) => sumRows(b.rows).equity - sumRows(a.rows).equity);
  };

  const pushGroup = (lines: string[], title: string, rows: HealthRow[], withMembers: boolean) => {
    if (rows.length === 0) return;
    lines.push(GROUP_RULE);
    lines.push(`<b>${title} (${rows.length})</b>`);
    lines.push(formatGroupTotals(periodHours, rows));
    if (withMembers) {
      for (const row of rows) {
        lines.push(formatMemberLine(row, periodHours));
      }
    }
  };

  const lines: string[] = [];
  pushGroup(lines, 'Копитрейдеры', copyRows, true);
  pushGroup(lines, 'Клиенты', clientRows, true);

  const exchanges = byExchange();
  if (exchanges.length > 0) {
    lines.push(GROUP_RULE);
    lines.push(`<b>По биржам (${exchanges.length})</b>`);
    for (const { ex, rows } of exchanges) {
      const g = sumRows(rows);
      lines.push(
        `  ${escapeHtml(ex)} (n=${rows.length}): ${formatUsdCompact(g.equity)} · Δ${periodHours}h: ${formatSignedUsd(g.delta)} · uPnL: ${formatSignedPlain(g.upnl)}`
      );
      lines.push(
        `    fill ${g.fills} (ср ${formatAvgFills(g.fills, g.n)}/портфель) · объем ${formatUsdCompact(g.volume)}`
      );
    }
  }

  return lines;
};

const COPY_BT_COMPARE: Array<{ setKey: string; short: string; apiKeyName: string; pid: string }> = [
  { setKey: 'portfolio-conservative-jul2026', short: 'P1 cons', apiKeyName: 'Copy_Alex1', pid: 'P1' },
  { setKey: 'portfolio-balanced-jul2026', short: 'P2 bal', apiKeyName: 'icopy1-api', pid: 'P2' },
  { setKey: 'portfolio-aggressive-jul2026', short: 'P3 aggr', apiKeyName: 'arcopy1', pid: 'P3' },
];
const LIVE_FIX_DAY = '2026-08-10';

const equityOnDate = async (apiKeyName: string, day: string, edge: 'start' | 'end'): Promise<number | null> => {
  const row = await db.get(
    edge === 'start'
      ? `SELECT m.equity_usd AS eq
         FROM mon.monitoring_snapshots m
         JOIN api_keys a ON a.id = m.api_key_id
         WHERE a.name = ? AND date(m.recorded_at) = date(?)
         ORDER BY datetime(m.recorded_at) ASC LIMIT 1`
      : `SELECT m.equity_usd AS eq
         FROM mon.monitoring_snapshots m
         JOIN api_keys a ON a.id = m.api_key_id
         WHERE a.name = ? AND date(m.recorded_at) = date(?)
         ORDER BY datetime(m.recorded_at) DESC LIMIT 1`,
    [apiKeyName, day],
  ) as { eq?: number } | undefined;
  const n = toFinite(row?.eq, NaN);
  return Number.isFinite(n) && n > 0 ? n : null;
};

const retBetween = (start: number | null, end: number | null): number | null => {
  if (!start || !end || start <= 0) return null;
  return (end / start - 1) * 100;
};

const formatFairLine = (
  item: { short: string },
  label: string,
  fair: any,
  liveRet: number | null,
  liveStats: { n?: number } | undefined,
  drift: any,
): string[] => {
  const dateFrom = String(fair?.dateFrom || '').slice(0, 10);
  const dateTo = String(fair?.dateTo || '').slice(0, 10);
  const btRet = fair && Number.isFinite(Number(fair.ret)) ? Number(fair.ret) : null;
  const gap = btRet != null && liveRet != null ? liveRet - btRet : null;
  const freq = drift?.freqX != null ? Number(drift.freqX) : null;
  const over = freq != null && freq > 2.5;
  const skipped = Number(fair?.skippedSymbols || 0);
  const err = String(fair?.error || '').trim();
  const lines: string[] = [
    `  ${item.short} ${label} ${escapeHtml(dateFrom || '?')}→${escapeHtml(dateTo || '?')}: `
    + `BT ${btRet == null ? (err ? 'fail' : 'n/a') : `${formatSignedPlain(btRet)}% / ${fair.trades}tr`} · `
    + `live ${liveRet == null ? 'n/a' : `${formatSignedPlain(liveRet)}% / ${liveStats?.n ?? '?'}ent`}`
    + (gap == null ? '' : ` · gap ${formatSignedPlain(gap)} п.п.`)
    + (freq == null ? '' : ` · freq ${freq.toFixed(1)}×${over ? ' ⚠' : ''}`)
    + (skipped > 0 ? ` · skip ${skipped} legs` : ''),
  ];
  const hot = Array.isArray(drift?.hot) ? drift.hot.slice(0, 3) : [];
  if (hot.length) {
    lines.push(`    лишние входы: ${hot.map((h: any) => `${h.sym} live ${h.live}/BT ${h.bt}`).join(', ')}`);
  }
  return lines;
};

const buildBtVsLiveLines = async (): Promise<string[]> => {
  const lines: string[] = [];
  for (const item of COPY_BT_COMPARE) {
    const row = await db.get(
      `SELECT snapshot_json FROM algofund_portfolios WHERE set_key = ?`,
      [item.setKey],
    ) as { snapshot_json?: string } | undefined;
    let snap: any = {};
    try { snap = JSON.parse(String(row?.snapshot_json || '{}')); } catch { snap = {}; }
    const fairLive = snap.fairLive;
    const fairFix = snap.fairSinceFix;
    const dateFrom = String(fairLive?.dateFrom || '2026-07-30').slice(0, 10);
    const dateTo = String(fairLive?.dateTo || fairFix?.dateTo || '').slice(0, 10);
    const startEq = await equityOnDate(item.apiKeyName, dateFrom, 'start');
    const endEq = dateTo ? await equityOnDate(item.apiKeyName, dateTo, 'end') : null;
    const fixStartEq = await equityOnDate(item.apiKeyName, LIVE_FIX_DAY, 'start');
    const preEnd = await equityOnDate(item.apiKeyName, '2026-08-09', 'end');
    const preStart = await equityOnDate(item.apiKeyName, '2026-07-30', 'start')
      || await equityOnDate(item.apiKeyName, '2026-07-31', 'start');
    const liveRet = retBetween(startEq, endEq);
    const liveFixRet = retBetween(fixStartEq, endEq);
    const preRet = retBetween(preStart, preEnd);
    if (fairLive == null && fairFix == null && liveRet == null) continue;
    lines.push(...formatFairLine(
      item,
      '$1k',
      fairLive || fairFix,
      liveRet,
      snap.tradeDrift?.liveFull || snap.tradeDrift?.liveSinceFix,
      snap.tradeDrift?.full || snap.tradeDrift?.sinceFix,
    ));
    if (fairFix && fairLive) {
      lines.push(...formatFairLine(
        item,
        'с 10.08',
        fairFix,
        liveFixRet,
        snap.tradeDrift?.liveSinceFix,
        snap.tradeDrift?.sinceFix,
      ));
    }
    if (preRet != null) {
      lines.push(`    до фикса 10.08: live ${formatSignedPlain(preRet)}% (лоты от max_deposit)`);
    }
  }
  if (lines.length === 0) return [];
  return [
    GROUP_RULE,
    '<b>BT vs live</b> — fair $1000, то же окно (не кривая с 2024 на миллионах)',
    ...lines,
  ];
};

/** Only true runtime breakages — not DD/margin/desync noise (those go to scheduled heartbeat). */
const isEmergencyHealthAlert = (text: string): boolean => {
  const t = String(text || '');
  if (/desync|CT churn|momentum-only|Momentum fleet|snapshot устарел|загрузка маржи|просадка |дублей SID/i.test(t)) {
    return false;
  }
  return /🛑|нет ни одного snapshot|agreement|Permission denied|нет свободного баланса|BingX execution/i.test(t);
};

/** Stable dedupe key: alert kind + client label, ignore floating $/%/мин. */
const stableAlertKeyFromLine = (line: string): string => {
  const plain = line.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  const client = (line.match(/<b>([^<]+)<\/b>/)?.[1] || plain.slice(0, 40)).trim();
  if (/нет ни одного snapshot/i.test(plain)) return `no_snapshot:${client}`;
  if (/Permission denied/i.test(plain)) return `weex_perm:${client}`;
  if (/нет свободного баланса/i.test(plain)) return `no_balance:${client}`;
  if (/agreement/i.test(plain)) return `bybit_agreement:${client}`;
  if (/BingX execution/i.test(plain)) return `bingx_exec:${client}`;
  if (/0 exchange_fill/i.test(plain)) return `zero_fill:${client}`;
  if (/🛑/.test(line)) return `critical:${client}`;
  return plain.replace(/[0-9]+(\.[0-9]+)?/g, '#').slice(0, 120);
};

const HEALTH_THRESHOLDS = {
  staleSnapshotMin: 30,   // снепшот старше 30 минут — алерт
  highMarginPct: 70,      // загрузка маржи
  highDdPct: 25,          // приближение к лимиту просадки
  duplicateSidGroups: 1,  // дубли source SID среди активных стратегий
  desyncMaxRatio: 0.2,    // у клиента <20% сделок от медианы по той же TS
  desyncMinMaster: 5,     // алерт включается, только если на TS медиана ≥ 5 сделок
  zeroExchangeFillHours: 24, // enabled клиент без exchange_fill за N часов
  momentumSilenceHours: 24, // fleet momentum: 0 signals + 0 fills
  ctMaxEntriesPerClient24h: 3, // ~1.5 synth cycles/day (entry+exit ≈ 2 events/cycle)
};

type ClientExecutionContext = {
  apiKeyName: string;
  momentumOnly: boolean;
  hasCtLegs: boolean;
  bingxPositionSideError: boolean;
  ctEntries24h: number;
};

const fetchClientExecutionContexts = async (apiKeyNames: string[]): Promise<Map<string, ClientExecutionContext>> => {
  const names = Array.from(new Set(apiKeyNames.map((v) => String(v || '').trim()).filter(Boolean)));
  const out = new Map<string, ClientExecutionContext>();
  if (names.length === 0) {
    return out;
  }
  const placeholders = names.map(() => '?').join(',');
  const rows = await db.all(
    `SELECT
       a.name AS api_key_name,
       SUM(CASE WHEN COALESCE(s.strategy_type, '') = 'momentum_scalp_tv' THEN 1 ELSE 0 END) AS momentum_legs,
       SUM(CASE WHEN COALESCE(s.strategy_type, '') NOT IN ('momentum_scalp_tv', 'dca', 'dca_futures') THEN 1 ELSE 0 END) AS non_momentum_legs,
       SUM(CASE WHEN COALESCE(s.strategy_type, '') = 'CT_Fractal' THEN 1 ELSE 0 END) AS ct_legs,
       MAX(CASE
         WHEN COALESCE(s.last_error, '') LIKE '%109400%'
           OR LOWER(COALESCE(s.last_error, '')) LIKE '%one-way mode%'
           OR LOWER(COALESCE(s.last_error, '')) LIKE '%positionside%'
         THEN 1 ELSE 0 END) AS bingx_pos_err,
       (SELECT COUNT(*)
        FROM live_trade_events lte
        JOIN strategies s2 ON s2.id = lte.strategy_id
        WHERE s2.api_key_id = a.id
          AND COALESCE(s2.strategy_type, '') = 'CT_Fractal'
          AND lte.trade_type = 'entry'
          AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill'
          AND lte.actual_time >= (strftime('%s', 'now', '-24 hours') * 1000)) AS ct_entries_24h
     FROM api_keys a
     LEFT JOIN strategies s ON s.api_key_id = a.id
       AND COALESCE(s.is_active, 0) = 1
       AND COALESCE(s.auto_update, 0) = 1
       AND COALESCE(s.is_archived, 0) = 0
     WHERE a.name IN (${placeholders})
     GROUP BY a.name`,
    names,
  ) as Array<{
    api_key_name?: string;
    momentum_legs?: number;
    non_momentum_legs?: number;
    ct_legs?: number;
    bingx_pos_err?: number;
    ct_entries_24h?: number;
  }>;

  for (const row of rows || []) {
    const apiKeyName = String(row.api_key_name || '').trim();
    if (!apiKeyName) continue;
    const momentumLegs = Math.max(0, Math.floor(toFinite(row.momentum_legs, 0)));
    const nonMomentumLegs = Math.max(0, Math.floor(toFinite(row.non_momentum_legs, 0)));
    out.set(apiKeyName, {
      apiKeyName,
      momentumOnly: momentumLegs > 0 && nonMomentumLegs === 0,
      hasCtLegs: Math.max(0, Math.floor(toFinite(row.ct_legs, 0))) > 0,
      bingxPositionSideError: Math.floor(toFinite(row.bingx_pos_err, 0)) > 0,
      ctEntries24h: Math.max(0, Math.floor(toFinite(row.ct_entries_24h, 0))),
    });
  }
  return out;
};

type MomentumFleetStats = {
  activeLegs: number;
  exchangeFills24h: number;
  signalEntries24h: number;
  lastFillAt: string | null;
  canaryArmed: boolean;
  canaryApiKey: string | null;
};

const fetchMomentumFleetStats = async (): Promise<MomentumFleetStats> => {
  const row = await db.get(
    `SELECT
       (SELECT COUNT(*)
        FROM strategies s
        JOIN api_keys a ON a.id = s.api_key_id
        JOIN algofund_profiles ap ON ap.execution_api_key_name = a.name OR ap.assigned_api_key_name = a.name
        JOIN tenants t ON t.id = ap.tenant_id
        WHERE COALESCE(ap.requested_enabled, 0) = 1
          AND COALESCE(ap.actual_enabled, 0) = 1
          AND COALESCE(s.is_active, 0) = 1
          AND COALESCE(s.auto_update, 0) = 1
          AND COALESCE(s.is_archived, 0) = 0
          AND COALESCE(s.strategy_type, '') = 'momentum_scalp_tv') AS active_legs,
       (SELECT COUNT(*)
        FROM live_trade_events lte
        JOIN strategies s ON s.id = lte.strategy_id
        WHERE COALESCE(s.strategy_type, '') = 'momentum_scalp_tv'
          AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill'
          AND lte.actual_time >= (strftime('%s', 'now', '-24 hours') * 1000)) AS fills_24h,
       (SELECT COUNT(*)
        FROM live_trade_events lte
        JOIN strategies s ON s.id = lte.strategy_id
        WHERE COALESCE(s.strategy_type, '') = 'momentum_scalp_tv'
          AND COALESCE(lte.event_origin, 'strategy_signal') = 'strategy_signal'
          AND lte.side IN ('long', 'short')
          AND lte.actual_time >= (strftime('%s', 'now', '-24 hours') * 1000)) AS signal_entries_24h,
       (SELECT datetime(MAX(lte.actual_time) / 1000, 'unixepoch')
        FROM live_trade_events lte
        JOIN strategies s ON s.id = lte.strategy_id
        WHERE COALESCE(s.strategy_type, '') = 'momentum_scalp_tv'
          AND COALESCE(lte.event_origin, 'exchange_fill') = 'exchange_fill') AS last_fill_at`,
  ) as {
    active_legs?: number;
    fills_24h?: number;
    signal_entries_24h?: number;
    last_fill_at?: string | null;
  } | undefined;

  const flagRow = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['runtime.momentum_bingx_canary']);
  let canaryArmed = false;
  let canaryApiKey: string | null = null;
  try {
    const parsed = JSON.parse(String(flagRow?.value || '')) as { enabled?: boolean; apiKeyName?: string };
    canaryArmed = parsed?.enabled === true;
    canaryApiKey = canaryArmed ? String(parsed.apiKeyName || 'HDB_15') : null;
  } catch {
    canaryArmed = false;
  }

  return {
    activeLegs: Math.max(0, Math.floor(toFinite(row?.active_legs, 0))),
    exchangeFills24h: Math.max(0, Math.floor(toFinite(row?.fills_24h, 0))),
    signalEntries24h: Math.max(0, Math.floor(toFinite(row?.signal_entries_24h, 0))),
    lastFillAt: row?.last_fill_at ? String(row.last_fill_at) : null,
    canaryArmed,
    canaryApiKey,
  };
};

const buildHealthSummary = async (periodHours: number): Promise<{ ok: boolean; text: string; alertKey: string }> => {
  const rows = await fetchHealthRows(periodHours);
  const duplicateSidByApiKey = await fetchDuplicateSidGroupsByApiKey(rows.map((r) => r.api_key_name || ''));
  const clientCtxByApiKey = await fetchClientExecutionContexts(rows.map((r) => r.api_key_name || ''));
  const total = rows.length;
  const enabledCount = rows.filter((r) => r.actual_enabled).length;
  const disabledCount = total - enabledCount;
  if (total === 0) {
    return { ok: true, text: `<b>📊 BTDD health (${periodHours}h)</b>\nАктивных algofund-клиентов нет.`, alertKey: 'ok' };
  }

  const nowMs = Date.now();
  // Equity/trades stats only over enabled (trading) clients — off assigned stay visible in count footnote.
  const enabledRows = rows.filter((r) => r.actual_enabled);
  const statsRows = enabledRows.length > 0 ? enabledRows : rows;
  const sumEquity = statsRows.reduce((s, r) => s + r.equity, 0);
  const sumEquityDelta = statsRows.reduce((s, r) => s + r.equity_delta, 0);
  const sumUpnl = statsRows.reduce((s, r) => s + r.upnl, 0);

  const alerts: string[] = [];

  // 1. STALE / NO snapshot
  for (const r of rows) {
    const tsMs = parseSqliteUtc(r.recorded_at);
    const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
    if (!tsMs) {
      alerts.push(`🔌 <b>${escapeHtml(label)}</b>: нет ни одного snapshot — ключ не отвечает (${escapeHtml(r.api_key_name || '-')})`);
      continue;
    }
    const ageMin = (nowMs - tsMs) / 60000;
    if (ageMin > HEALTH_THRESHOLDS.staleSnapshotMin) {
      alerts.push(`⏱ <b>${escapeHtml(label)}</b>: snapshot устарел ${ageMin.toFixed(0)} мин назад`);
    }
  }

  // 2. HIGH MARGIN
  for (const r of rows) {
    if (r.margin >= HEALTH_THRESHOLDS.highMarginPct) {
      const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
      alerts.push(`⚠️ <b>${escapeHtml(label)}</b>: загрузка маржи ${r.margin.toFixed(1)}% (порог ${HEALTH_THRESHOLDS.highMarginPct}%)`);
    }
  }

  // 3. HIGH DD
  for (const r of rows) {
    if (r.dd >= HEALTH_THRESHOLDS.highDdPct) {
      const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
      alerts.push(`📉 <b>${escapeHtml(label)}</b>: просадка ${r.dd.toFixed(1)}% (порог ${HEALTH_THRESHOLDS.highDdPct}%)`);
    }
  }

  // 4. DUPLICATE STRATEGY SID GROUPS (zombie clones after switch_system)
  for (const r of rows) {
    const dupGroups = duplicateSidByApiKey.get(String(r.api_key_name || '')) || 0;
    if (dupGroups >= HEALTH_THRESHOLDS.duplicateSidGroups) {
      const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
      alerts.push(
        `🧬 <b>${escapeHtml(label)}</b>: найдено дублей SID-групп: ${dupGroups} (двойные стратегии могут удваивать входы и нагрузку маржи)`
      );
    }
  }

  // 5. ZERO exchange_fill: торговля включена, но на бирже 0 fill за 24ч.
  const momentum = await fetchMomentumFleetStats();
  const momentumRegimeSilent = momentum.activeLegs > 0
    && momentum.exchangeFills24h === 0
    && momentum.signalEntries24h === 0;

  for (const r of rows) {
    if (r.exchange_fills_24h > 0) continue;
    const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
    const apiKey = String(r.api_key_name || '').trim();
    const ctx = apiKey ? clientCtxByApiKey.get(apiKey) : undefined;
    const tsMs = parseSqliteUtc(r.recorded_at);
    const snapshotAgeMin = tsMs ? (nowMs - tsMs) / 60000 : Number.POSITIVE_INFINITY;
    const err = String(r.last_error || '');

    // Momentum-only + fleet regime silence → не дублируем (см. fleet-алерт ниже).
    if (ctx?.momentumOnly && momentumRegimeSilent) {
      continue;
    }
    // Stale snapshot >2ч — клиент уже в stale-алерте, не шумим zero-fill.
    if (snapshotAgeMin > 120) {
      continue;
    }
    // BingX/часть WEEX пишут strategy_signal при реальных ордерах, но не exchange_fill —
    // это дыра телеметрии, не «торговля мертва».
    if (r.signals_24h > 0) {
      continue;
    }
    if (/permission denied|-1051/i.test(err)) {
      alerts.push(
        `🛑 <b>${escapeHtml(label)}</b>: WEEX Permission denied (−1051), 0 fill — почини trade-права API (${escapeHtml(apiKey || '-')})`,
      );
      continue;
    }
    if (/no available balance/i.test(err)) {
      alerts.push(
        `🛑 <b>${escapeHtml(label)}</b>: нет свободного баланса, 0 fill (${escapeHtml(apiKey || '-')})`,
      );
      continue;
    }
    if (/sign the required agreement/i.test(err)) {
      alerts.push(
        `🛑 <b>${escapeHtml(label)}</b>: Bybit demo — нужно подписать agreement по контракту (${escapeHtml(apiKey || '-')})`,
      );
      continue;
    }
    if (ctx?.bingxPositionSideError) {
      alerts.push(
        `🛑 <b>${escapeHtml(label)}</b>: BingX execution bug — one-way/positionSide (0 fill за 24ч, ${escapeHtml(apiKey || '-')})`,
      );
      continue;
    }
    if (ctx?.momentumOnly) {
      alerts.push(
        `📉 <b>${escapeHtml(label)}</b>: momentum-only, 0 fill за 24ч — ждём сигнал (regime/chop, ${escapeHtml(apiKey || '-')})`,
      );
      continue;
    }
    alerts.push(
      `🛑 <b>${escapeHtml(label)}</b>: 0 exchange_fill за ${HEALTH_THRESHOLDS.zeroExchangeFillHours}ч при включённой торговле (${escapeHtml(apiKey || '-')}) — проверь BingX/WEEX исполнение`,
    );
  }

  // 6. MOMENTUM fleet silence: enabled legs but 0 signals and 0 fills in 24h.
  if (
    momentum.activeLegs > 0
    && momentum.exchangeFills24h === 0
    && momentum.signalEntries24h === 0
  ) {
    const lastFill = momentum.lastFillAt ? escapeHtml(momentum.lastFillAt) : 'никогда';
    const canaryHint = momentum.canaryArmed
      ? ` · canary armed: ${escapeHtml(momentum.canaryApiKey || 'HDB_15')}`
      : '';
    alerts.push(
      `📉 <b>Momentum fleet</b>: 0 raw signals и 0 exchange_fill за ${HEALTH_THRESHOLDS.momentumSilenceHours}ч `
      + `(${momentum.activeLegs} ног) — вероятно regime_no_signal; последний fill: ${lastFill}${canaryHint}`,
    );
  } else if (
    momentum.activeLegs > 0
    && momentum.exchangeFills24h === 0
    && momentum.signalEntries24h > 0
  ) {
    alerts.push(
      `⚠️ <b>Momentum fleet</b>: ${momentum.signalEntries24h} strategy_signal за 24ч, но 0 exchange_fill `
      + `(${momentum.activeLegs} ног) — проверь исполнение (BingX/WEEX)`,
    );
  }

  // 7. DESYNC: для каждой TS считаем медиану trades_period; кто <20% от медианы — алерт.
  const byTs = new Map<string, HealthRow[]>();
  for (const r of rows) {
    const ts = (r.system_name || '').trim();
    if (!ts) continue;
    if (!byTs.has(ts)) byTs.set(ts, []);
    byTs.get(ts)!.push(r);
  }
  for (const [ts, group] of byTs) {
    if (group.length < 2) continue;
    const sorted = [...group].map((r) => r.trades_period).sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
    if (median < HEALTH_THRESHOLDS.desyncMinMaster) continue;
    const cutoff = Math.max(1, Math.floor(median * HEALTH_THRESHOLDS.desyncMaxRatio));
    const lagging = group.filter((r) => r.trades_period < cutoff);
    for (const r of lagging) {
      const apiKey = String(r.api_key_name || '').trim();
      const ctx = apiKey ? clientCtxByApiKey.get(apiKey) : undefined;
      const tsMs = parseSqliteUtc(r.recorded_at);
      const snapshotAgeMin = tsMs ? (nowMs - tsMs) / 60000 : Number.POSITIVE_INFINITY;
      if (r.exchange_fills_24h === 0 && (snapshotAgeMin > 120 || ctx?.bingxPositionSideError || (ctx?.momentumOnly && momentumRegimeSilent))) {
        continue;
      }
      const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
      alerts.push(`🔀 <b>${escapeHtml(label)}</b>: desync — ${r.trades_period} сделок vs медиана ${median} по TS ${escapeHtml(shorten(ts, 40))}`);
    }
  }

  // 7b. Bybit demo agreement — even if other fills exist (stocks book on BTDD_D1).
  for (const r of rows) {
    if (!r.actual_enabled) continue;
    if (!/sign the required agreement/i.test(String(r.last_error || ''))) continue;
    const label = r.display_name || r.tenant_slug || r.api_key_name || 'client';
    alerts.push(
      `🛑 <b>${escapeHtml(label)}</b>: Bybit demo — нужно подписать agreement по контракту (${escapeHtml(r.api_key_name || '-')})`,
    );
  }

  // 8. CT churn: >1.5 synth cycles/client/day (proxy: CT entries/24h).
  const ctHotClients = rows
    .map((r) => {
      const apiKey = String(r.api_key_name || '').trim();
      const ctx = apiKey ? clientCtxByApiKey.get(apiKey) : undefined;
      return { row: r, ctx, entries: ctx?.ctEntries24h || 0 };
    })
    .filter((item) => item.ctx?.hasCtLegs && item.entries > HEALTH_THRESHOLDS.ctMaxEntriesPerClient24h)
    .sort((a, b) => b.entries - a.entries);
  for (const item of ctHotClients.slice(0, 5)) {
    const label = item.row.display_name || item.row.tenant_slug || item.row.api_key_name || 'client';
    alerts.push(
      `⚡ <b>${escapeHtml(label)}</b>: CT churn — ${item.entries} entry/24ч (порог ${HEALTH_THRESHOLDS.ctMaxEntriesPerClient24h}, цель ≤1.5 synth cycles/день)`,
    );
  }

  const headerOk = `✅ <b>BTDD: всё OK</b> (${periodHours}ч)`;
  const headerBad = `🚨 <b>BTDD: алерты ${alerts.length}/${total}</b> (${periodHours}ч)`;

  const worstDd = statsRows.reduce((w, r) => r.dd > w.dd ? r : w, statsRows[0]);
  const fillsTotal = statsRows.reduce((s, r) => s + r.fills_period, 0);
  const volumeTotal = statsRows.reduce((s, r) => s + r.volume_period, 0);
  const deltaSign = sumEquityDelta >= 0 ? '+' : '';
  const upnlSign = sumUpnl >= 0 ? '+' : '';
  const aumLines = buildAumBreakdownLines(statsRows, periodHours);
  const btLiveLines = await buildBtVsLiveLines();
  const stats = [
    `Всего: ${enabledCount}${disabledCount > 0 ? ` (+${disabledCount} выкл назначенных)` : ''} · equity: $${sumEquity.toFixed(0)} · Δ${periodHours}h: ${deltaSign}$${sumEquityDelta.toFixed(2)} · uPnL: ${upnlSign}${sumUpnl.toFixed(2)}`,
    ...aumLines,
    ...btLiveLines,
    GROUP_RULE,
    `Сделок (fill) за ${periodHours}ч: ${fillsTotal} · ср. на портфель: ${formatAvgFills(fillsTotal, statsRows.length)} · объем: ${formatUsdCompact(volumeTotal)} · worst DD: ${worstDd.dd.toFixed(1)}% (${escapeHtml(worstDd.display_name || worstDd.api_key_name || '')})`,
  ].join('\n');

  const emergencyAlerts = alerts.filter(isEmergencyHealthAlert);
  const shownSource = emergencyAlerts.length > 0 ? emergencyAlerts : alerts;
  const shown = shownSource.slice(0, 25);
  const more = shownSource.length > shown.length ? `\n<i>...+${shownSource.length - shown.length} ещё</i>` : '';

  if (emergencyAlerts.length === 0) {
    const noiseNote = alerts.length > 0
      ? `\n<i>шум ${alerts.length} (dd/margin/desync/stale/churn) — в heartbeat ${await getReportIntervalMinutesFromDb()} мин, не poll 10 мин</i>`
      : '';
    return { ok: true, text: `${headerOk}\n${stats}${noiseNote}`, alertKey: 'ok' };
  }
  const alertKey = [...new Set(shown.map(stableAlertKeyFromLine))].sort().join('|');
  return {
    ok: false,
    text: `${headerBad}\n${stats}\n\n${shown.join('\n')}${more}`,
    alertKey,
  };
};

const sendHealthSummary = async (periodHours: number): Promise<void> => {
  const { text } = await buildHealthSummary(periodHours);
  await sendTelegramMessage(trimTelegramText(text));
};

const sendPeriodicReportShort = async (periodHours: number, runtimeOnly = false): Promise<void> => {
  const [accountsEnabled, driftEnabled, lowLotEnabled] = await Promise.all([
    isSectionEnabled('accounts'),
    isSectionEnabled('drift'),
    isSectionEnabled('lowlot'),
  ]);
  const [lines, driftLines, lowLotLines] = await Promise.all([
    accountsEnabled ? buildAccountLines(periodHours, runtimeOnly) : [],
    driftEnabled ? buildDriftAlertLines(periodHours, 5) : [],
    lowLotEnabled ? buildLowLotLines(periodHours, 5) : [],
  ]);

  const header = `<b>📊 BTDD: Короткий отчет за ${periodHours}ч</b>`;
  const parts: string[] = [header];

  if (accountsEnabled) {
    if (lines.length > 0) {
      const topLines = lines.slice(0, 5);
      parts.push('<b>Ключи / аккаунты</b>');
      parts.push(topLines.join('\n'));
      if (lines.length > 5) {
        parts.push(`<i>...+${lines.length - 5} more</i>`);
      }
    } else {
      parts.push('Активные ключи не найдены');
    }
  }

  const alerts = [...driftLines, ...lowLotLines];
  if (alerts.length > 0) {
    parts.push('');
    parts.push(`<b>⚠️ Алерты (${alerts.length})</b>`);
    parts.push(alerts.slice(0, 4).join('\n'));
  }

  if (!accountsEnabled && !driftEnabled && !lowLotEnabled) {
    parts.push('Все секции отчета отключены');
  }

  await sendTelegramMessage(trimTelegramText(parts.join('\n')));
};

const sendPeriodicReport = async (periodHours: number, runtimeOnly = false, format: 'short' | 'full' | 'verbose' = 'full'): Promise<void> => {
  // Default behaviour ('short' / 'full') is the lightweight health summary:
  // ✅ "all OK" or only the list of problem accounts.
  // The verbose per-client dump is kept under format === 'verbose' for diagnostics.
  if (format === 'verbose') {
    // fallthrough to legacy verbose builder below
  } else if (format === 'short') {
    return sendHealthSummary(periodHours);
  } else {
    return sendHealthSummary(periodHours);
  }
  const [accountsEnabled, driftEnabled, lowLotEnabled] = await Promise.all([
    isSectionEnabled('accounts'),
    isSectionEnabled('drift'),
    isSectionEnabled('lowlot'),
  ]);
  const [lines, driftLines, lowLotLines] = await Promise.all([
    accountsEnabled ? buildAccountLines(periodHours, runtimeOnly) : [],
    driftEnabled ? buildDriftAlertLines(periodHours) : [],
    lowLotEnabled ? buildLowLotLines(periodHours) : [],
  ]);

  const header = `<b>BTDD Admin Report (${periodHours}h)</b>`;
  const blocks: string[] = [];

  if (accountsEnabled) {
    blocks.push('<b>1) Аккаунты и runtime</b>');
    blocks.push(lines.length > 0 ? lines.join('\n') : 'Нет данных по аккаунтам');
  }

  if (driftEnabled) {
    blocks.push('');
    blocks.push('<b>2) Drift-алерты</b>');
    blocks.push(driftLines.length > 0 ? driftLines.join('\n') : 'Drift-алертов за период нет');
  }

  if (lowLotEnabled) {
    blocks.push('');
    blocks.push('<b>3) Low-lot сигналы</b>');
    blocks.push(lowLotLines.length > 0 ? lowLotLines.join('\n') : 'Low-lot сигналов за период нет');
  }

  if (blocks.length === 0) {
    blocks.push('Все секции отчета отключены');
  }

  const body = blocks.join('\n');
  await sendTelegramMessage(trimTelegramText(`${header}\n${body}`));
};

const sendNewLoginAlerts = async (state: ReporterState): Promise<void> => {
  const rows = await db.all(
    `SELECT cu.id, cu.email, cu.full_name, cu.last_login_at, t.slug
     FROM client_users cu
     LEFT JOIN tenants t ON t.id = cu.tenant_id
     WHERE COALESCE(cu.last_login_at, '') <> ''
       AND datetime(cu.last_login_at) > datetime(?)
     ORDER BY datetime(cu.last_login_at) ASC`,
    [state.lastLoginAtIso || '1970-01-01 00:00:00']
  );

  const list = Array.isArray(rows) ? rows : [];
  for (const row of list) {
    const message = [
      '<b>New client login</b>',
      `tenant=${escapeHtml(String(row?.slug || ''))}`,
      `user=${escapeHtml(String(row?.email || ''))}`,
      `name=${escapeHtml(String(row?.full_name || ''))}`,
      `at=${escapeHtml(String(row?.last_login_at || ''))}`,
    ].join('\n');
    await sendTelegramMessage(message);
  }

  if (list.length > 0) {
    const latest = String(list[list.length - 1]?.last_login_at || '').trim();
    if (latest) {
      state.lastLoginAtIso = latest;
    }
  }
};

// ── Watchdog ─────────────────────────────────────────────────────────────────

type WatchdogState = {
  lastAlertAtMs: number;
};

const WATCHDOG_COOLDOWN_MS = 60 * 60_000; // 60 min between watchdog pings
const watchdogState: WatchdogState = { lastAlertAtMs: 0 };

const isWatchdogEnabledDb = async (): Promise<boolean> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['admin.report.settings']);
  if (!row?.value) {
    return true;
  }
  try {
    const s = JSON.parse(String(row.value));
    if (s && typeof s.watchdogEnabled === 'boolean') {
      return s.watchdogEnabled;
    }
    if (s && typeof s.watchdogEnabled === 'string') {
      return s.watchdogEnabled !== '0' && s.watchdogEnabled !== 'false';
    }
  } catch {
    // ignore parse error
  }
  return true;
};

/**
 * Notify admin about a new client registration.
 */
export const notifyAdminUrgent = async (text: string): Promise<void> => {
  if (!(await isAdminReporterEnabledInDb()) || !isEnabled()) {
    return;
  }
  await sendTelegramMessage(trimTelegramText(text));
};

export const notifyAdminNewUser = async (info: {
  email: string;
  displayName: string;
  productMode: string;
  planCode: string;
}): Promise<void> => {
  if (!isEnabled()) return;
  const text = [
    `🆕 <b>Новый клиент зарегистрировался!</b>`,
    ``,
    `📧 Email: <code>${escapeHtml(info.email)}</code>`,
    `👤 Имя: ${escapeHtml(info.displayName)}`,
    `📦 Режим: ${escapeHtml(info.productMode)}`,
    `💰 Тариф: ${escapeHtml(info.planCode)}`,
    `🕐 ${new Date().toISOString()}`,
  ].join('\n');
  try {
    await sendTelegramMessage(text);
  } catch (e) {
    logger.warn(`[tg-admin] Failed to send new-user notification: ${(e as Error).message}`);
  }
};

/**
 * Checks for recent rate-limit bursts and API/runtime failure spikes.
 * Sends an immediate Telegram alert if thresholds are exceeded.
 * Hard cooldown 60 min to avoid spam.
 */
export const sendWatchdogAlertIfNeeded = async (): Promise<void> => {
  if (!isEnabled()) {
    return;
  }
  if (Date.now() - watchdogState.lastAlertAtMs < WATCHDOG_COOLDOWN_MS) {
    return;
  }
  if (!(await isAdminReporterEnabledInDb())) {
    return;
  }
  if (!(await isWatchdogEnabledDb())) {
    return;
  }

  const windowMs = 15 * 60_000; // last 15 minutes
  const since = Date.now() - windowMs;

  const rateLimitRows = await db.all(
    `SELECT COUNT(*) AS cnt
     FROM strategy_runtime_events
     WHERE event_type = 'rate_limit_error'
       AND created_at >= ?`,
    [since]
  ) as Array<{ cnt?: number }>;
  const rateLimitCount = Number(rateLimitRows[0]?.cnt || 0);

  const lowLotRows = await db.all(
    `SELECT COUNT(DISTINCT strategy_id) AS cnt
     FROM strategy_runtime_events
     WHERE event_type = 'low_lot_error'
       AND resolved_at = 0
       AND created_at >= ?`,
    [since]
  ) as Array<{ cnt?: number }>;
  const lowLotCount = Number(lowLotRows[0]?.cnt || 0);

  const failedCycleRows = await db.all(
    `SELECT COUNT(*) AS cnt
     FROM strategy_runtime_events
     WHERE event_type = 'auto_cycle_failed'
       AND created_at >= ?`,
    [since]
  ) as Array<{ cnt?: number }>;
  const failedCount = Number(failedCycleRows[0]?.cnt || 0);

  const alerts: string[] = [];
  if (rateLimitCount >= 5) {
    alerts.push(`🚦 <b>Rate-limit burst:</b> ${rateLimitCount} events за 15 мин`);
  }
  if (lowLotCount >= 2) {
    alerts.push(`📉 <b>Low-lot:</b> ${lowLotCount} стратегий с ошибкой min lot за 15 мин`);
  }
  if (failedCount >= 10) {
    alerts.push(`❌ <b>Цикл авто-торговли:</b> ${failedCount} сбоев подряд за 15 мин`);
  }

  if (alerts.length === 0) {
    return;
  }

  watchdogState.lastAlertAtMs = Date.now();
  const dateStr = new Date().toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  const text = `⚠️ <b>BTDD Watchdog Alert</b> (${escapeHtml(dateStr)})\n\n${alerts.join('\n')}\n\n<i>Следующий алерт не раньше чем через 60 мин</i>`;
  try {
    await sendTelegramMessage(text);
    logger.info(`[tg-watchdog] Alert sent: ${alerts.join('; ')}`);
  } catch (error) {
    logger.warn(`[tg-watchdog] Failed to send alert: ${(error as Error).message}`);
  }
};

export const runAdminTelegramReportNow = async (options?: ReportNowOptions): Promise<void> => {
  if (!isEnabled()) {
    logger.info('[tg-admin] Report-now skipped (missing TELEGRAM_ADMIN_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID)');
    return;
  }

  if (!(await isAdminReporterEnabledInDb())) {
    logger.info('[tg-admin] Report-now skipped (telegram.admin.enabled=0)');
    return;
  }

  const periodHours = Math.max(1, Math.floor(Number(options?.periodHours || process.env.TELEGRAM_ADMIN_REPORT_HOURS || 12) || 12));
  const includeLoginAlerts = options?.includeLoginAlerts !== false;
  const runtimeOnly = Boolean(options?.runtimeOnly);
  const format = options?.format || 'full';
  const state: ReporterState = {
    lastReportAtMs: 0,
    lastLoginAtIso: await getLatestLoginAtIso(),
  };

  if (includeLoginAlerts) {
    await sendNewLoginAlerts(state);
  }

  await sendPeriodicReport(periodHours, runtimeOnly, format);
};

export const startAdminTelegramReporter = async (): Promise<void> => {
  if (!isEnabled()) {
    logger.info('[tg-admin] Disabled (missing TELEGRAM_ADMIN_BOT_TOKEN or TELEGRAM_ADMIN_CHAT_ID)');
    return;
  }

  if (!(await isAdminReporterEnabledInDb())) {
    logger.info('[tg-admin] Disabled by runtime flag telegram.admin.enabled=0');
    return;
  }

  const reportHours = Math.max(1, Math.floor(Number(process.env.TELEGRAM_ADMIN_REPORT_HOURS || 12) || 12));
  const pollMinutes = Math.max(1, Math.floor(Number(process.env.TELEGRAM_ADMIN_POLL_MINUTES || 10) || 10));

  const state: ReporterState = {
    lastReportAtMs: 0,
    lastLoginAtIso: await getLatestLoginAtIso(),
  };

  // Anti-spam for alert summary: store last sent alert-set hash + ts.
  const alertState: { lastHash: string; lastSentMs: number } = { lastHash: '', lastSentMs: 0 };
  const partnerDigestState: { lastSentMs: number } = { lastSentMs: Date.now() };
  const PARTNER_DIGEST_HOURS = Math.max(1, Math.floor(Number(process.env.TELEGRAM_PARTNER_TRADES_HOURS || 8) || 8));
  const ALERT_REPEAT_MS = 60 * 60_000; // повторяем тот же набор алертов не чаще раза в час

  const hashAlertText = (text: string): string => {
    let h = 0;
    for (let i = 0; i < text.length; i += 1) {
      h = (h * 31 + text.charCodeAt(i)) | 0;
    }
    return String(h);
  };

  const runTick = async () => {
    try {
      await sendNewLoginAlerts(state);

      const nowMs = Date.now();
      const intervalMinutes = await getReportIntervalMinutesFromDb();
      const intervalMs = intervalMinutes * 60_000;
      const heartbeatDue = state.lastReportAtMs === 0 || nowMs - state.lastReportAtMs >= intervalMs;
      const partnerDigestMs = Math.max(intervalMs, PARTNER_DIGEST_HOURS * 3_600_000);

      // Считаем health summary каждый тик.
      const summary = await buildHealthSummary(reportHours);

      if (!summary.ok) {
        // Чрезвычайное: шлём сразу. Дедуп по стабильному ключу (без плавающих $/%), не чаще часа.
        const hash = summary.alertKey || hashAlertText(summary.text);
        const sameAsLast = hash === alertState.lastHash;
        const cooledDown = nowMs - alertState.lastSentMs >= ALERT_REPEAT_MS;
        if (!sameAsLast || cooledDown) {
          await sendTelegramMessage(trimTelegramText(summary.text));
          alertState.lastHash = hash;
          alertState.lastSentMs = nowMs;
          state.lastReportAtMs = nowMs;
          logger.info(`[tg-admin] Emergency sent (alerts=${hash.slice(0, 80)})`);
        }
      } else if (heartbeatDue) {
        // Всё ОК — короткий heartbeat по расписанию.
        await sendTelegramMessage(trimTelegramText(summary.text));
        state.lastReportAtMs = nowMs;
        alertState.lastHash = '';
        logger.info(`[tg-admin] Heartbeat sent (interval=${intervalMinutes}m)`);
      }

      // Watchdog: rate-limit / low-lot / failed cycles (отдельный канал, свой cooldown).
      await sendWatchdogAlertIfNeeded();

      if (nowMs - partnerDigestState.lastSentMs >= partnerDigestMs) {
        try {
          const { buildPartnerTradesTelegramDigest } = await import('../saas/partnerService');
          const digest = await buildPartnerTradesTelegramDigest(PARTNER_DIGEST_HOURS);
          await sendTelegramMessage(trimTelegramText(digest));
          partnerDigestState.lastSentMs = nowMs;
        } catch (digestErr) {
          logger.warn(`[tg-admin] partner trades digest failed: ${(digestErr as Error).message}`);
        }
      }
    } catch (error) {
      logger.warn(`[tg-admin] tick failed: ${(error as Error).message}`);
    }
  };

  await runTick();
  setInterval(() => {
    void runTick();
  }, pollMinutes * 60_000);

  logger.info(`[tg-admin] Started: heartbeat=DB-flag (default 24h), partnerDigest=max(heartbeat, ${PARTNER_DIGEST_HOURS}h), poll=${pollMinutes}m, emergencies=immediate (cooldown 60m, stable key)`);
};

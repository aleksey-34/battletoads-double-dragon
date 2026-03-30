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
  format?: 'short' | 'full';
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
  return Number.isFinite(parsed) && parsed >= 5 ? Math.min(1440, parsed) : 60;
};

const isRuntimeOnlyEnabledInDb = async (): Promise<boolean> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', ['telegram.admin.runtimeonly']);
  const value = String(row?.value || '').trim().toLowerCase();
  return value === '1' || value === 'true' || value === 'yes' || value === 'on';
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
         AND COALESCE(ap.actual_enabled, 0) = 1

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
       FROM monitoring_snapshots m1
       JOIN (
         SELECT api_key_id, MAX(datetime(recorded_at)) AS max_at
         FROM monitoring_snapshots
         GROUP BY api_key_id
       ) mx ON mx.api_key_id = m1.api_key_id AND datetime(m1.recorded_at) = mx.max_at
     ) ms_latest ON ms_latest.api_key_id = a.id
     LEFT JOIN (
       SELECT m2.api_key_id, m2.equity_usd
       FROM monitoring_snapshots m2
       JOIN (
         SELECT api_key_id, MIN(datetime(recorded_at)) AS min_at
         FROM monitoring_snapshots
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
    if (trades === 0) {
      warnings.push('NO_TRADES');
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
       FROM monitoring_snapshots m1
       JOIN (
         SELECT api_key_id, MAX(datetime(recorded_at)) AS max_at
         FROM monitoring_snapshots
         GROUP BY api_key_id
       ) mx ON mx.api_key_id = m1.api_key_id AND datetime(m1.recorded_at) = mx.max_at
     ) ms_latest ON ms_latest.api_key_id = a.id
     LEFT JOIN (
       SELECT m2.api_key_id, m2.equity_usd
       FROM monitoring_snapshots m2
       JOIN (
         SELECT api_key_id, MIN(datetime(recorded_at)) AS min_at
         FROM monitoring_snapshots
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
    if (trades === 0) {
      warnings.push('NO_TRADES');
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
    [`-${freshHours} hours`, Math.max(1, Math.floor(limit))]
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

const sendPeriodicReportShort = async (periodHours: number, runtimeOnly = false): Promise<void> => {
  const [lines, driftLines, lowLotLines] = await Promise.all([
    buildAccountLines(periodHours, runtimeOnly),
    buildDriftAlertLines(periodHours, 5),
    buildLowLotLines(periodHours, 5),
  ]);

  const header = `<b>📊 BTDD: Короткий отчет за ${periodHours}ч</b>`;
  const parts: string[] = [header];

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

  const alerts = [...driftLines, ...lowLotLines];
  if (alerts.length > 0) {
    parts.push('');
    parts.push(`<b>⚠️ Алерты (${alerts.length})</b>`);
    parts.push(alerts.slice(0, 4).join('\n'));
  }

  await sendTelegramMessage(trimTelegramText(parts.join('\n')));
};

const sendPeriodicReport = async (periodHours: number, runtimeOnly = false, format: 'short' | 'full' = 'full'): Promise<void> => {
  if (format === 'short') {
    return sendPeriodicReportShort(periodHours, runtimeOnly);
  }
  const [lines, driftLines, lowLotLines] = await Promise.all([
    buildAccountLines(periodHours, runtimeOnly),
    buildDriftAlertLines(periodHours),
    buildLowLotLines(periodHours),
  ]);

  const header = `<b>BTDD Admin Report (${periodHours}h)</b>`;
  const blocks: string[] = [];

  blocks.push('<b>1) Аккаунты и runtime</b>');
  blocks.push(lines.length > 0 ? lines.join('\n') : 'Нет данных по аккаунтам');

  blocks.push('');
  blocks.push('<b>2) Drift-алерты</b>');
  blocks.push(driftLines.length > 0 ? driftLines.join('\n') : 'Drift-алертов за период нет');

  blocks.push('');
  blocks.push('<b>3) Low-lot сигналы</b>');
  blocks.push(lowLotLines.length > 0 ? lowLotLines.join('\n') : 'Low-lot сигналов за период нет');

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

const WATCHDOG_COOLDOWN_MS = 10 * 60_000; // 10 min between repeated alerts
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
 * Checks for recent rate-limit bursts and API/runtime failure spikes.
 * Sends an immediate Telegram alert if thresholds are exceeded.
 * Hard cooldown 10 min to avoid spam.
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
  const text = `⚠️ <b>BTDD Watchdog Alert</b> (${escapeHtml(dateStr)})\n\n${alerts.join('\n')}\n\n<i>Следующий алерт не раньше чем через 10 мин</i>`;
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

  const runTick = async () => {
    try {
      await sendNewLoginAlerts(state);

      const nowMs = Date.now();
      const intervalMinutes = await getReportIntervalMinutesFromDb();
      const intervalMs = intervalMinutes * 60_000;
      if (state.lastReportAtMs === 0 || nowMs - state.lastReportAtMs >= intervalMs) {
        const runtimeOnly = await isRuntimeOnlyEnabledInDb();
        await sendPeriodicReport(reportHours, runtimeOnly, 'full');
        state.lastReportAtMs = nowMs;
      }

      // Watchdog: instant alert for rate-limit burst / low-lot spike
      await sendWatchdogAlertIfNeeded();
    } catch (error) {
      logger.warn(`[tg-admin] tick failed: ${(error as Error).message}`);
    }
  };

  await runTick();
  setInterval(() => {
    void runTick();
  }, pollMinutes * 60_000);

  logger.info(`[tg-admin] Started: report=${reportHours}h, poll=${pollMinutes}m, interval=DB`);
};

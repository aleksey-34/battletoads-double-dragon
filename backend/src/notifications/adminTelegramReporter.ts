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
       SELECT m1.api_key_id, m1.equity_usd, m1.margin_load_percent, m1.drawdown_percent
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
      `${escapeHtml(displayName || tenantSlug || executionApiKeyName || 'client')} (${escapeHtml(mode)}#${profileId}) | ${keyPart}${scopePart} | trades=${trades} | delta=${delta.toFixed(2)} | eq=${eqLatest.toFixed(2)} | ml=${margin.toFixed(1)}% | dd=${dd.toFixed(1)}%${warnings.length ? ` | ${warnings.join(',')}` : ''}`
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
       COALESCE(ms_old.equity_usd, COALESCE(ms_latest.equity_usd, 0)) AS equity_old,
       COALESCE(ms_latest.margin_load_percent, 0) AS margin_load,
       COALESCE(ms_latest.drawdown_percent, 0) AS drawdown,
       COALESCE(tr.cnt, 0) AS trades_count
     FROM api_keys a
     LEFT JOIN (
       SELECT m1.api_key_id, m1.equity_usd, m1.margin_load_percent, m1.drawdown_percent
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
      `${escapeHtml(apiKeyName)} | trades=${trades} | delta=${delta.toFixed(2)} | eq=${eqLatest.toFixed(2)} | ml=${margin.toFixed(1)}% | dd=${dd.toFixed(1)}%${warnings.length ? ` | ${warnings.join(',')}` : ''}`
    );
  }

  return out;
};

const buildDriftAlertLines = async (periodHours: number, limit = 8): Promise<string[]> => {
  const rows = await db.all(
    `SELECT
       a.name AS api_key_name,
       s.id AS strategy_id,
       s.name AS strategy_name,
       da.metric_name,
       da.severity,
       da.drift_percent,
       da.description,
       da.created_at
     FROM drift_alerts da
     JOIN strategies s ON s.id = da.strategy_id
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE da.created_at >= (strftime('%s', 'now', ?) * 1000)
     ORDER BY da.created_at DESC
     LIMIT ?`,
    [`-${periodHours} hours`, Math.max(1, Math.floor(limit))]
  );

  const list = Array.isArray(rows) ? rows : [];
  return list.map((row) => {
    const apiKey = escapeHtml(String(row?.api_key_name || ''));
    const strategyId = Math.max(0, Math.floor(toFinite(row?.strategy_id, 0)));
    const strategyName = escapeHtml(shorten(String(row?.strategy_name || ''), 40));
    const metric = escapeHtml(String(row?.metric_name || 'metric'));
    const severity = String(row?.severity || 'warning').toLowerCase() === 'critical' ? 'critical' : 'warning';
    const drift = toFinite(row?.drift_percent, 0);
    const description = escapeHtml(shorten(String(row?.description || ''), 120));
    return `${apiKey} | S#${strategyId} ${strategyName} | ${severity.toUpperCase()} ${metric} drift=${drift.toFixed(1)}% | ${description}`;
  });
};

const buildLowLotLines = async (periodHours: number, limit = 8): Promise<string[]> => {
  const rows = await db.all(
    `SELECT
       a.name AS api_key_name,
       s.id AS strategy_id,
       s.name AS strategy_name,
       s.base_symbol,
       s.quote_symbol,
       s.last_error,
       s.max_deposit,
       s.leverage,
       s.lot_long_percent,
       s.lot_short_percent,
       s.updated_at
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE COALESCE(s.last_error, '') <> ''
       AND datetime(s.updated_at) >= datetime('now', ?)
       AND lower(s.last_error) LIKE '%order size too small%'
     ORDER BY datetime(s.updated_at) DESC
     LIMIT ?`,
    [`-${periodHours} hours`, Math.max(1, Math.floor(limit))]
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

const sendPeriodicReport = async (periodHours: number, runtimeOnly = false): Promise<void> => {
  const [lines, driftLines, lowLotLines] = await Promise.all([
    buildAccountLines(periodHours, runtimeOnly),
    buildDriftAlertLines(periodHours),
    buildLowLotLines(periodHours),
  ]);

  const header = `<b>BTDD Admin Report (${periodHours}h)</b>`;
  const blocks: string[] = [];

  blocks.push('<b>Accounts</b>');
  blocks.push(lines.length > 0 ? lines.join('\n') : 'No accounts found');

  blocks.push('');
  blocks.push('<b>Drift alerts</b>');
  blocks.push(driftLines.length > 0 ? driftLines.join('\n') : 'No drift alerts in period');

  blocks.push('');
  blocks.push('<b>Low-lot signals</b>');
  blocks.push(lowLotLines.length > 0 ? lowLotLines.join('\n') : 'No low-lot signals in period');

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
  const state: ReporterState = {
    lastReportAtMs: 0,
    lastLoginAtIso: await getLatestLoginAtIso(),
  };

  if (includeLoginAlerts) {
    await sendNewLoginAlerts(state);
  }

  await sendPeriodicReport(periodHours, runtimeOnly);
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
      if (state.lastReportAtMs === 0 || nowMs - state.lastReportAtMs >= reportHours * 3600_000) {
        const runtimeOnly = await isRuntimeOnlyEnabledInDb();
        await sendPeriodicReport(reportHours, runtimeOnly);
        state.lastReportAtMs = nowMs;
      }
    } catch (error) {
      logger.warn(`[tg-admin] tick failed: ${(error as Error).message}`);
    }
  };

  await runTick();
  setInterval(() => {
    void runTick();
  }, pollMinutes * 60_000);

  logger.info(`[tg-admin] Started: report=${reportHours}h, poll=${pollMinutes}m`);
};

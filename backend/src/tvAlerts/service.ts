import { createHash, randomBytes } from 'crypto';
import { db } from '../utils/database';
import {
  TvAlertConfig,
  TvAlertProfileRow,
  TvAlertRow,
  TvLotMode,
  TvPositionRow,
  TvSignalConflictMode,
  defaultTvAlertConfig,
  parseTvAlertConfig,
} from './types';

const slugify = (value: string): string => {
  const base = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return base || 'alert';
};

const newWebhookSecret = (): string => randomBytes(24).toString('hex');

export const getTvAlertsProfile = async (tenantId: number): Promise<TvAlertProfileRow | null> => {
  const row = await db.get(
    'SELECT * FROM tv_alerts_profiles WHERE tenant_id = ? LIMIT 1',
    [tenantId]
  ) as TvAlertProfileRow | undefined;
  return row || null;
};

export const updateTvAlertsProfile = async (
  tenantId: number,
  patch: Partial<{
    defaultApiKeyName: string;
    defaultExchange: string;
    enabled: boolean;
    signalConflictMode: TvSignalConflictMode;
    globalSettings: Record<string, unknown>;
  }>,
): Promise<TvAlertProfileRow> => {
  const existing = await getTvAlertsProfile(tenantId);
  if (!existing) {
    await db.run(
      `INSERT INTO tv_alerts_profiles (tenant_id, created_at, updated_at)
       VALUES (?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId]
    );
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (patch.defaultApiKeyName !== undefined) {
    fields.push('default_api_key_name = ?');
    values.push(String(patch.defaultApiKeyName || '').trim());
  }
  if (patch.defaultExchange !== undefined) {
    fields.push('default_exchange = ?');
    values.push(String(patch.defaultExchange || 'bybit').trim().toLowerCase());
  }
  if (patch.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(patch.enabled ? 1 : 0);
  }
  if (patch.signalConflictMode !== undefined) {
    fields.push('signal_conflict_mode = ?');
    values.push(patch.signalConflictMode);
  }
  if (patch.globalSettings !== undefined) {
    fields.push('global_settings_json = ?');
    values.push(JSON.stringify(patch.globalSettings || {}));
  }

  if (fields.length > 0) {
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(tenantId);
    await db.run(
      `UPDATE tv_alerts_profiles SET ${fields.join(', ')} WHERE tenant_id = ?`,
      values
    );
  }

  const updated = await getTvAlertsProfile(tenantId);
  if (!updated) {
    throw new Error('TV alerts profile not found');
  }
  return updated;
};

export const listTvAlerts = async (tenantId: number): Promise<Array<TvAlertRow & { config: TvAlertConfig }>> => {
  const rows = await db.all(
    `SELECT * FROM tv_alerts WHERE tenant_id = ? ORDER BY id DESC`,
    [tenantId]
  ) as TvAlertRow[];

  return rows.map((row) => ({
    ...row,
    config: parseTvAlertConfig(row.config_json),
  }));
};

export const getTvAlertById = async (tenantId: number, alertId: number): Promise<(TvAlertRow & { config: TvAlertConfig }) | null> => {
  const row = await db.get(
    'SELECT * FROM tv_alerts WHERE tenant_id = ? AND id = ? LIMIT 1',
    [tenantId, alertId]
  ) as TvAlertRow | undefined;
  if (!row) {
    return null;
  }
  return { ...row, config: parseTvAlertConfig(row.config_json) };
};

export const getTvAlertByWebhook = async (
  tenantSlug: string,
  alertSlug: string,
  secret: string,
): Promise<(TvAlertRow & { config: TvAlertConfig; tenant_slug: string }) | null> => {
  const row = await db.get(
    `SELECT a.*, t.slug AS tenant_slug
     FROM tv_alerts a
     JOIN tenants t ON t.id = a.tenant_id
     WHERE t.slug = ? AND a.slug = ? AND a.webhook_secret = ? AND a.enabled = 1
       AND t.status = 'active'
     LIMIT 1`,
    [tenantSlug, alertSlug, secret]
  ) as (TvAlertRow & { tenant_slug: string }) | undefined;

  if (!row) {
    return null;
  }
  return { ...row, config: parseTvAlertConfig(row.config_json) };
};

const ensureUniqueAlertSlug = async (tenantId: number, base: string): Promise<string> => {
  let slug = slugify(base);
  let attempt = 0;
  while (attempt < 20) {
    const existing = await db.get(
      'SELECT id FROM tv_alerts WHERE tenant_id = ? AND slug = ? LIMIT 1',
      [tenantId, slug]
    );
    if (!existing?.id) {
      return slug;
    }
    attempt += 1;
    slug = `${slugify(base)}-${attempt}`;
  }
  return `${slugify(base)}-${randomBytes(3).toString('hex')}`;
};

export type CreateTvAlertInput = {
  name: string;
  symbol: string;
  exchange?: string;
  apiKeyName?: string;
  lotMode?: TvLotMode;
  lotValue?: number;
  leverage?: number;
  config?: TvAlertConfig;
  enabled?: boolean;
};

export const createTvAlert = async (tenantId: number, input: CreateTvAlertInput) => {
  const name = String(input.name || '').trim();
  if (!name) {
    throw new Error('Alert name is required');
  }
  const symbol = String(input.symbol || '').trim().toUpperCase();
  if (!symbol) {
    throw new Error('Symbol is required');
  }

  const slug = await ensureUniqueAlertSlug(tenantId, name);
  const secret = newWebhookSecret();
  const profile = await getTvAlertsProfile(tenantId);
  const config = input.config || defaultTvAlertConfig();

  const result = await db.run(
    `INSERT INTO tv_alerts (
       tenant_id, name, slug, webhook_secret, symbol, exchange, api_key_name,
       enabled, lot_mode, lot_value, leverage, config_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      tenantId,
      name,
      slug,
      secret,
      symbol,
      String(input.exchange || profile?.default_exchange || 'bybit').trim().toLowerCase(),
      String(input.apiKeyName || profile?.default_api_key_name || '').trim(),
      input.enabled === false ? 0 : 1,
      input.lotMode === 'percent_deposit' ? 'percent_deposit' : 'usdt',
      Math.max(1, Number(input.lotValue) || 100),
      Math.max(1, Number(input.leverage) || 1),
      JSON.stringify(config),
    ]
  );

  const alertId = Number((result as { lastID?: number }).lastID || 0);
  const created = await getTvAlertById(tenantId, alertId);
  if (!created) {
    throw new Error('Failed to create alert');
  }
  return created;
};

export type UpdateTvAlertInput = Partial<CreateTvAlertInput> & {
  regenerateSecret?: boolean;
};

export const updateTvAlert = async (tenantId: number, alertId: number, input: UpdateTvAlertInput) => {
  const existing = await getTvAlertById(tenantId, alertId);
  if (!existing) {
    throw new Error('Alert not found');
  }

  const fields: string[] = [];
  const values: unknown[] = [];

  if (input.name !== undefined) {
    fields.push('name = ?');
    values.push(String(input.name).trim());
  }
  if (input.symbol !== undefined) {
    fields.push('symbol = ?');
    values.push(String(input.symbol).trim().toUpperCase());
  }
  if (input.exchange !== undefined) {
    fields.push('exchange = ?');
    values.push(String(input.exchange).trim().toLowerCase());
  }
  if (input.apiKeyName !== undefined) {
    fields.push('api_key_name = ?');
    values.push(String(input.apiKeyName).trim());
  }
  if (input.lotMode !== undefined) {
    fields.push('lot_mode = ?');
    values.push(input.lotMode === 'percent_deposit' ? 'percent_deposit' : 'usdt');
  }
  if (input.lotValue !== undefined) {
    fields.push('lot_value = ?');
    values.push(Math.max(1, Number(input.lotValue) || 100));
  }
  if (input.leverage !== undefined) {
    fields.push('leverage = ?');
    values.push(Math.max(1, Number(input.leverage) || 1));
  }
  if (input.enabled !== undefined) {
    fields.push('enabled = ?');
    values.push(input.enabled ? 1 : 0);
  }
  if (input.config !== undefined) {
    fields.push('config_json = ?');
    values.push(JSON.stringify(input.config));
  }
  if (input.regenerateSecret) {
    fields.push('webhook_secret = ?');
    values.push(newWebhookSecret());
  }

  if (fields.length === 0) {
    return existing;
  }

  fields.push('updated_at = CURRENT_TIMESTAMP');
  values.push(tenantId, alertId);
  await db.run(
    `UPDATE tv_alerts SET ${fields.join(', ')} WHERE tenant_id = ? AND id = ?`,
    values
  );

  const updated = await getTvAlertById(tenantId, alertId);
  if (!updated) {
    throw new Error('Alert not found after update');
  }
  return updated;
};

export const deleteTvAlert = async (tenantId: number, alertId: number): Promise<void> => {
  const open = await getOpenPositionForAlert(alertId);
  if (open) {
    throw new Error('Cannot delete alert with an open position. Close the position first.');
  }
  await db.run('DELETE FROM tv_alert_events WHERE alert_id = ? AND tenant_id = ?', [alertId, tenantId]);
  await db.run('DELETE FROM tv_alert_positions WHERE alert_id = ? AND tenant_id = ?', [alertId, tenantId]);
  await db.run('DELETE FROM tv_alerts WHERE id = ? AND tenant_id = ?', [alertId, tenantId]);
};

export const getOpenPositionForAlert = async (alertId: number): Promise<TvPositionRow | null> => {
  const row = await db.get(
    `SELECT * FROM tv_alert_positions
     WHERE alert_id = ? AND status = 'open'
     ORDER BY id DESC LIMIT 1`,
    [alertId]
  ) as TvPositionRow | undefined;
  return row || null;
};

export const listOpenPositionsForTenant = async (tenantId: number): Promise<TvPositionRow[]> => {
  return db.all(
    `SELECT * FROM tv_alert_positions
     WHERE tenant_id = ? AND status = 'open'
     ORDER BY opened_at DESC`,
    [tenantId]
  ) as Promise<TvPositionRow[]>;
};

export const listTvAlertEvents = async (
  tenantId: number,
  alertId?: number,
  limit = 50,
): Promise<Array<Record<string, unknown>>> => {
  if (alertId) {
    return db.all(
      `SELECT * FROM tv_alert_events
       WHERE tenant_id = ? AND alert_id = ?
       ORDER BY id DESC LIMIT ?`,
      [tenantId, alertId, limit]
    ) as Promise<Array<Record<string, unknown>>>;
  }
  return db.all(
    `SELECT * FROM tv_alert_events
     WHERE tenant_id = ?
     ORDER BY id DESC LIMIT ?`,
    [tenantId, limit]
  ) as Promise<Array<Record<string, unknown>>>;
};

export const logTvAlertEvent = async (payload: {
  tenantId: number;
  alertId?: number;
  positionId?: number;
  source: string;
  action: string;
  status: string;
  body: unknown;
  errorMessage?: string;
}): Promise<number> => {
  const result = await db.run(
    `INSERT INTO tv_alert_events (
       alert_id, tenant_id, position_id, source, action, status,
       payload_json, error_message, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
    [
      payload.alertId || null,
      payload.tenantId,
      payload.positionId || null,
      payload.source,
      payload.action,
      payload.status,
      JSON.stringify(payload.body || {}),
      String(payload.errorMessage || ''),
    ]
  );
  return Number((result as { lastID?: number }).lastID || 0);
};

export const buildWebhookUrl = (tenantSlug: string, alertSlug: string, secret: string): string => {
  const base = String(process.env.APP_BASE_URL || process.env.CLIENT_BASE_URL || '').trim().replace(/\/$/, '');
  const path = `/api/webhooks/tradingview/${encodeURIComponent(tenantSlug)}/${encodeURIComponent(alertSlug)}/${secret}`;
  return base ? `${base}${path}` : path;
};

export const hashWebhookPayload = (body: unknown): string => {
  return createHash('sha256').update(JSON.stringify(body || {})).digest('hex').slice(0, 16);
};

export const getTvAlertsWorkspaceState = async (tenantId: number) => {
  const profile = await getTvAlertsProfile(tenantId);
  const alerts = await listTvAlerts(tenantId);
  const openPositions = await listOpenPositionsForTenant(tenantId);
  const recentEvents = await listTvAlertEvents(tenantId, undefined, 30);

  return {
    profile: profile ? {
      defaultApiKeyName: profile.default_api_key_name,
      defaultExchange: profile.default_exchange,
      enabled: Boolean(profile.enabled),
      signalConflictMode: profile.signal_conflict_mode,
      globalSettings: (() => {
        try {
          return JSON.parse(profile.global_settings_json || '{}');
        } catch {
          return {};
        }
      })(),
    } : null,
    alerts: alerts.map((alert) => ({
      id: alert.id,
      name: alert.name,
      slug: alert.slug,
      symbol: alert.symbol,
      exchange: alert.exchange,
      apiKeyName: alert.api_key_name,
      enabled: Boolean(alert.enabled),
      lotMode: alert.lot_mode,
      lotValue: alert.lot_value,
      leverage: alert.leverage,
      config: alert.config,
      webhookUrl: buildWebhookUrl(
        '', // filled by route with tenant slug
        alert.slug,
        alert.webhook_secret,
      ),
      createdAt: alert.created_at,
      updatedAt: alert.updated_at,
    })),
    openPositions,
    recentEvents,
  };
};

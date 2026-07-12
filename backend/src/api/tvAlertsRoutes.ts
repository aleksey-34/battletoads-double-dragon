import { Router } from 'express';
import { db } from '../utils/database';
import logger from '../utils/logger';
import { authenticateClient } from '../utils/auth';
import {
  buildWebhookUrl,
  createTvAlert,
  deleteTvAlert,
  getTvAlertById,
  getTvAlertsWorkspaceState,
  listTvAlertEvents,
  updateTvAlert,
  updateTvAlertsProfile,
} from '../tvAlerts/service';
import { manualTvTerminalAction, processTradingViewWebhook } from '../tvAlerts/engine';
import { parseTvAlertConfig } from '../tvAlerts/types';

const router = Router();

const requireTvAlertsClient = (req: any, res: any, next: () => void) => {
  const mode = String(req?.clientAuth?.user?.productMode || '');
  // Beta: dual / strategy workspaces also get TV Alerts cabinet (profile auto-provisioned).
  if (!['tv_alerts_client', 'dual', 'strategy_client'].includes(mode)) {
    return res.status(403).json({ error: 'TradingView Alerts is not enabled for this workspace' });
  }
  return next();
};

router.post('/webhooks/tradingview/:tenantSlug/:alertSlug/:secret', async (req, res) => {
  try {
    const result = await processTradingViewWebhook(
      String(req.params.tenantSlug || ''),
      String(req.params.alertSlug || ''),
      String(req.params.secret || ''),
      req.body,
    );
    const status = result.ok ? 200 : 400;
    return res.status(status).json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`[tvAlerts] Webhook handler error: ${err.message}`);
    return res.status(500).json({ ok: false, message: err.message });
  }
});

router.get('/client/tv-alerts/workspace', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const tenantSlug = String((req as any).clientAuth?.user?.tenantSlug || '');
    const state = await getTvAlertsWorkspaceState(tenantId);

    const alerts = state.alerts.map((alert) => {
      const full = state.alerts.find((a) => a.id === alert.id);
      const row = full as { slug?: string; webhook_secret?: string } | undefined;
      return {
        ...alert,
        webhookUrl: buildWebhookUrl(tenantSlug, String(alert.slug), String((row as any)?.webhook_secret || '')),
      };
    });

    // Re-fetch secrets from DB for webhook URLs
    const dbAlerts = await db.all(
      'SELECT id, slug, webhook_secret FROM tv_alerts WHERE tenant_id = ?',
      [tenantId]
    ) as Array<{ id: number; slug: string; webhook_secret: string }>;

    const alertsWithUrls = state.alerts.map((alert) => {
      const secretRow = dbAlerts.find((r) => r.id === alert.id);
      return {
        ...alert,
        webhookUrl: secretRow
          ? buildWebhookUrl(tenantSlug, secretRow.slug, secretRow.webhook_secret)
          : alert.webhookUrl,
      };
    });

    return res.json({
      success: true,
      auth: (req as any).clientAuth?.user,
      ...state,
      alerts: alertsWithUrls,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`[tvAlerts] Workspace load error: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

router.patch('/client/tv-alerts/profile', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const profile = await updateTvAlertsProfile(tenantId, {
      defaultApiKeyName: req.body?.defaultApiKeyName,
      defaultExchange: req.body?.defaultExchange,
      enabled: req.body?.enabled,
      signalConflictMode: req.body?.signalConflictMode,
      globalSettings: req.body?.globalSettings,
    });
    return res.json({ success: true, profile });
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
});

router.post('/client/tv-alerts', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const created = await createTvAlert(tenantId, {
      name: req.body?.name,
      symbol: req.body?.symbol,
      exchange: req.body?.exchange,
      apiKeyName: req.body?.apiKeyName,
      lotMode: req.body?.lotMode,
      lotValue: req.body?.lotValue,
      leverage: req.body?.leverage,
      config: req.body?.config,
      enabled: req.body?.enabled,
    });
    const tenantSlug = String((req as any).clientAuth?.user?.tenantSlug || '');
    return res.json({
      success: true,
      alert: {
        ...created,
        webhookUrl: buildWebhookUrl(tenantSlug, created.slug, created.webhook_secret),
      },
    });
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
});

router.patch('/client/tv-alerts/:alertId', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const alertId = Number(req.params.alertId);
    const updated = await updateTvAlert(tenantId, alertId, {
      name: req.body?.name,
      symbol: req.body?.symbol,
      exchange: req.body?.exchange,
      apiKeyName: req.body?.apiKeyName,
      lotMode: req.body?.lotMode,
      lotValue: req.body?.lotValue,
      leverage: req.body?.leverage,
      config: req.body?.config,
      enabled: req.body?.enabled,
      regenerateSecret: Boolean(req.body?.regenerateSecret),
    });
    const tenantSlug = String((req as any).clientAuth?.user?.tenantSlug || '');
    return res.json({
      success: true,
      alert: {
        ...updated,
        webhookUrl: buildWebhookUrl(tenantSlug, updated.slug, updated.webhook_secret),
      },
    });
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
});

router.delete('/client/tv-alerts/:alertId', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    await deleteTvAlert(tenantId, Number(req.params.alertId));
    return res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
});

router.get('/client/tv-alerts/:alertId/events', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const events = await listTvAlertEvents(tenantId, Number(req.params.alertId), 100);
    return res.json({ success: true, events });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

router.post('/client/tv-alerts/:alertId/terminal', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const result = await manualTvTerminalAction(
      tenantId,
      Number(req.params.alertId),
      req.body?.action,
      { percent: req.body?.percent, qty: req.body?.qty },
    );
    return res.json(result);
  } catch (error) {
    const err = error as Error;
    return res.status(400).json({ error: err.message });
  }
});

router.get('/client/tv-alerts/:alertId', authenticateClient, requireTvAlertsClient, async (req, res) => {
  try {
    const tenantId = Number((req as any).clientAuth?.user?.tenantId);
    const alert = await getTvAlertById(tenantId, Number(req.params.alertId));
    if (!alert) {
      return res.status(404).json({ error: 'Alert not found' });
    }
    const tenantSlug = String((req as any).clientAuth?.user?.tenantSlug || '');
    return res.json({
      success: true,
      alert: {
        ...alert,
        config: parseTvAlertConfig(alert.config_json),
        webhookUrl: buildWebhookUrl(tenantSlug, alert.slug, alert.webhook_secret),
      },
    });
  } catch (error) {
    const err = error as Error;
    return res.status(500).json({ error: err.message });
  }
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';
import { db } from '../../utils/database';
import {
  authenticateClient,
  completeClientOnboarding,
  getClientAuthPayloadFromSession,
  loginClientByMagicToken,
  loginClientUser,
  registerClientUser,
  revokeClientSession,
} from '../../utils/auth';
import { notifyAdminNewUser } from '../../notifications/adminTelegramReporter';
import { invalidatePublicPortfolioCacheForSlug } from '../../saas/publicPortfolioCache';
import logger from '../../utils/logger';
import { initResearchDb } from '../../research/db';
import { getClientPreviewJobPayload } from '../../research/clientPreviewQueue';
import { getPreset, listOfferIds } from '../../research/presetBuilder';
import { ensureExchangeClientInitialized, removeExchangeClient } from '../../bot/exchange';
import { saveApiKey } from '../../config/settings';
import { getMonitoringBundle, getMonitoringLatest, recordMonitoringSnapshot } from '../../bot/monitoring';
import {
  getAlgofundState,
  materializeAlgofundPortfolioFull,
  listClientCustomTsSystemsState,
  previewClientCustomTsSystemById,
  saveClientCustomTsSystemFromDraft,
  startClientCustomTsSystem,
  stopClientCustomTsSystem,
  getStrategyClientState,
  getStrategyClientCustomTsDraft,
  previewStrategyClientOffer,
  previewStrategyClientCustomTsDraft,
  previewStrategyClientSelection,
  requestAlgofundAction,
  updateAlgofundState,
  updateStrategyClientCustomTsDraft,
  updateStrategyClientState,
} from '../../saas/service';
import {
  exchangeRequiresPassphrase,
  isLevel3,
  resolveClientAuthErrorStatus,
  resolveClientWorkspaceErrorStatus,
  toOptionalBool,
  toOptionalNumber,
} from './helpers';
import {
  CLIENT_EXCHANGE_GUIDES,
  CLIENT_GUIDES_IMAGES_DIR,
  CLIENT_GUIDES_ROOT_DIR,
} from './clientGuides';

const router = Router();

router.post('/auth/client/register', async (req, res) => {
  try {
    const result = await registerClientUser(
      {
        email: req.body?.email,
        password: req.body?.password,
        fullName: req.body?.fullName,
        companyName: req.body?.companyName,
        preferredLanguage: req.body?.preferredLanguage,
        productMode: req.body?.productMode,
        planCode: req.body?.planCode,
        showFutures: req.body?.showFutures !== false,
        showSpot: req.body?.showSpot !== false,
        riskDisclaimerAccepted: req.body?.riskDisclaimerAccepted === true,
        riskDisclaimerVersion: req.body?.riskDisclaimerVersion,
      },
      {
        ip: String(req.ip || ''),
        userAgent: String(req.headers['user-agent'] || ''),
      }
    );

    res.json({ success: true, ...result });

    // Async notification — don't block response
    notifyAdminNewUser({
      email: String(req.body?.email || '').trim() || `guest/${result.user?.tenantSlug || 'unknown'}`,
      displayName: String(req.body?.fullName || req.body?.companyName || result.user?.tenantDisplayName || ''),
      productMode: String(req.body?.productMode || 'strategy_client'),
      planCode: 'auto (self-registration)',
    }).catch(() => {});
  } catch (error) {
    const err = error as Error;
    const statusCode = resolveClientAuthErrorStatus(err.message);
    logger.error(`Client self-registration error: ${err.message}`);
    res.status(statusCode).json({ error: err.message });
  }
});

router.post('/auth/client/login', async (req, res) => {
  try {
    const result = await loginClientUser(
      {
        email: req.body?.email,
        password: req.body?.password,
      },
      {
        ip: String(req.ip || ''),
        userAgent: String(req.headers['user-agent'] || ''),
      }
    );

    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    const statusCode = resolveClientAuthErrorStatus(err.message);
    logger.error(`Client login error: ${err.message}`);
    res.status(statusCode).json({ error: err.message });
  }
});

router.post('/auth/client/magic-login', async (req, res) => {
  try {
    const result = await loginClientByMagicToken(String(req.body?.token || ''), {
      ip: String(req.ip || ''),
      userAgent: String(req.headers['user-agent'] || ''),
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client magic login error: ${err.message}`);
    res.status(400).json({ error: err.message });
  }
});

router.post('/auth/client/set-password', authenticateClient, async (req, res) => {
  try {
    const newPassword = String(req.body?.newPassword || '').trim();
    if (!newPassword) {
      return res.status(400).json({ error: 'New password is required' });
    }
    if (newPassword.length < 10) {
      return res.status(400).json({ error: 'Password must be at least 10 characters' });
    }

    const session = (req as any).clientAuth;
    if (!session?.user_id) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const userId = Number(session.user_id);
    const passwordHash = await bcrypt.hash(newPassword, 10);

    await db.run(
      `UPDATE client_users SET password_hash = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
      [passwordHash, userId]
    );

    res.json({ success: true, message: 'Password set successfully' });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client set password error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/preview', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const offerId = String(req.body?.offerId || '').trim();
    if (!offerId) {
      return res.status(400).json({ error: 'offerId is required' });
    }
    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const preview = await previewStrategyClientOffer(
      Number(session.user.tenantId),
      offerId,
      req.body?.riskLevel,
      req.body?.tradeFrequencyLevel,
      toOptionalNumber(req.body?.riskScore),
      toOptionalNumber(req.body?.tradeFrequencyScore)
    );

    res.json({ success: true, ...preview });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/selection-preview', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const preview = await previewStrategyClientSelection(Number(session.user.tenantId), {
      selectedOfferIds: Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      riskLevel: req.body?.riskLevel,
      tradeFrequencyLevel: req.body?.tradeFrequencyLevel,
      riskScore: toOptionalNumber(req.body?.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body?.tradeFrequencyScore),
    });

    res.json({ success: true, ...preview });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy selection preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/strategy/preview-job/:jobId', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const jobId = Number.parseInt(String(req.params.jobId || '0'), 10);
    if (!Number.isFinite(jobId) || jobId <= 0) {
      return res.status(400).json({ error: 'Invalid jobId' });
    }

    const payload = await getClientPreviewJobPayload(Number(session.user.tenantId), jobId);
    if (!payload) {
      return res.status(404).json({ error: 'Preview job not found' });
    }

    res.json({ success: true, ...payload });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client preview job status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/client/onboarding/complete', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.id) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    await completeClientOnboarding(Number(session.user.id));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client onboarding completion error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/guides', authenticateClient, async (_req, res) => {
  const guides = Object.values(CLIENT_EXCHANGE_GUIDES).map((guide) => ({
    id: guide.id,
    title: guide.title,
    downloadUrl: `/api/client/guides/${guide.id}`,
    contentUrl: `/api/client/guides/${guide.id}/content`,
  }));

  res.json({ success: true, guides });
});

router.get('/client/guides/assets/:fileName', authenticateClient, async (req, res) => {
  const fileName = path.basename(String(req.params.fileName || '').trim());
  const lowerName = fileName.toLowerCase();
  if (!lowerName || !/\.(svg|png|jpg|jpeg|webp)$/i.test(lowerName)) {
    return res.status(400).json({ error: 'Invalid guide asset file' });
  }

  const filePath = path.join(CLIENT_GUIDES_IMAGES_DIR, fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Guide asset not found' });
  }

  return res.sendFile(filePath);
});

router.get('/client/guides/:exchangeId/content', authenticateClient, async (req, res) => {
  const exchangeId = String(req.params.exchangeId || '').trim().toLowerCase();
  const guide = CLIENT_EXCHANGE_GUIDES[exchangeId];

  if (!guide) {
    return res.status(404).json({ error: 'Guide not found' });
  }

  const filePath = path.join(CLIENT_GUIDES_ROOT_DIR, guide.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Guide file not found' });
  }

  const rawContent = fs.readFileSync(filePath, 'utf-8');
  const content = rawContent.replace(/\]\(images\/([^\)]+)\)/gi, '](/api/client/guides/assets/$1)');

  return res.json({
    success: true,
    guide: {
      id: guide.id,
      title: guide.title,
      content,
    },
  });
});

router.get('/client/guides/:exchangeId', authenticateClient, async (req, res) => {
  const exchangeId = String(req.params.exchangeId || '').trim().toLowerCase();
  const guide = CLIENT_EXCHANGE_GUIDES[exchangeId];

  if (!guide) {
    return res.status(404).json({ error: 'Guide not found' });
  }

  const filePath = path.join(CLIENT_GUIDES_ROOT_DIR, guide.fileName);
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: 'Guide file not found' });
  }

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${guide.fileName}"`);
  res.sendFile(filePath);
});

router.get('/client/workspace', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const productMode = session.user.productMode;

    const [strategyResult, algofundResult, tenantRow] = await Promise.all([
      getStrategyClientState(tenantId).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      ),
      getAlgofundState(tenantId, toOptionalNumber(req.query.riskMultiplier), false).then(
        (value) => ({ status: 'fulfilled' as const, value }),
        (reason) => ({ status: 'rejected' as const, reason }),
      ),
      db.get(
        'SELECT client_preferences_json FROM tenants WHERE id = ? LIMIT 1',
        [tenantId]
      ) as Promise<{ client_preferences_json?: string } | undefined>,
    ]);

    if (strategyResult.status === 'rejected') {
      logger.warn(`Client workspace strategy state unavailable for tenant ${tenantId}: ${strategyResult.reason instanceof Error ? strategyResult.reason.message : String(strategyResult.reason)}`);
    }
    if (algofundResult.status === 'rejected') {
      logger.warn(`Client workspace algofund state unavailable for tenant ${tenantId}: ${algofundResult.reason instanceof Error ? algofundResult.reason.message : String(algofundResult.reason)}`);
    }

    let publicDescription = '';
    try {
      const prefs = JSON.parse(String(tenantRow?.client_preferences_json || '{}'));
      publicDescription = String(prefs?.publicDescription || '').trim().slice(0, 500);
    } catch {
      publicDescription = '';
    }

    return res.json({
      success: true,
      auth: getClientAuthPayloadFromSession(session),
      productMode,
      publicDescription,
      strategyState: strategyResult.status === 'fulfilled' ? strategyResult.value : null,
      algofundState: algofundResult.status === 'fulfilled' ? algofundResult.value : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client workspace load error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/strategy/state', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const state = await getStrategyClientState(Number(session.user.tenantId));
    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy workspace state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/client/strategy/profile', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const state = await updateStrategyClientState(Number(session.user.tenantId), {
      selectedOfferIds: Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      riskLevel: req.body?.riskLevel,
      tradeFrequencyLevel: req.body?.tradeFrequencyLevel,
      assignedApiKeyName: req.body?.assignedApiKeyName !== undefined ? String(req.body.assignedApiKeyName || '').trim() : undefined,
      requestedEnabled: toOptionalBool(req.body?.requestedEnabled),
    });

    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy profile save error: ${err.message}`);
    res.status(resolveClientWorkspaceErrorStatus(err.message)).json({ error: err.message });
  }
});

router.get('/client/strategy/backtest-requests', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const rows = await db.all(
      `SELECT id, tenant_id, base_symbol, quote_symbol, interval, note, status, created_at, decided_at
       FROM strategy_backtest_pair_requests
       WHERE tenant_id = ?
       ORDER BY id DESC
       LIMIT 100`,
      [Number(session.user.tenantId)]
    );

    res.json({ success: true, requests: rows || [] });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy backtest request list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/backtest-request', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const market = String(req.body?.market || '').trim().toUpperCase();
    const baseSymbolRaw = String(req.body?.baseSymbol || '').trim().toUpperCase();
    const quoteSymbolRaw = String(req.body?.quoteSymbol || '').trim().toUpperCase();
    const interval = String(req.body?.interval || '1h').trim();
    const note = String(req.body?.note || '').trim().slice(0, 400);

    let baseSymbol = baseSymbolRaw;
    let quoteSymbol = quoteSymbolRaw;

    if (!baseSymbol && market) {
      if (market.includes('/')) {
        const [base, quote] = market.split('/');
        baseSymbol = String(base || '').trim().toUpperCase();
        quoteSymbol = String(quote || '').trim().toUpperCase();
      } else {
        baseSymbol = market;
      }
    }

    if (!baseSymbol) {
      return res.status(400).json({ error: 'market or baseSymbol is required' });
    }

    const inserted = await db.run(
      `INSERT INTO strategy_backtest_pair_requests (
         tenant_id, base_symbol, quote_symbol, interval, note, status, created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'pending', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [Number(session.user.tenantId), baseSymbol, quoteSymbol, interval || '1h', note]
    );

    const requestId = Number(inserted?.lastID || 0);

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_strategy_backtest_pair_request', ?, CURRENT_TIMESTAMP)`,
      [
        Number(session.user.tenantId),
        JSON.stringify({ requestId, baseSymbol, quoteSymbol, interval, note }),
      ]
    );

    res.json({
      success: true,
      request: {
        id: requestId,
        tenant_id: Number(session.user.tenantId),
        base_symbol: baseSymbol,
        quote_symbol: quoteSymbol,
        interval: interval || '1h',
        note,
        status: 'pending',
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy backtest request create error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/auth/client/me', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    res.json({ success: true, ...getClientAuthPayloadFromSession(session) });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client me error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/client/profile', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const displayNameProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'displayName');
    const descriptionProvided = Object.prototype.hasOwnProperty.call(req.body || {}, 'publicDescription');
    if (!displayNameProvided && !descriptionProvided) {
      return res.status(400).json({ error: 'displayName or publicDescription is required' });
    }

    const displayNameRaw = displayNameProvided ? String(req.body?.displayName || '').trim() : '';
    if (displayNameProvided) {
      if (!displayNameRaw) {
        return res.status(400).json({ error: 'displayName is required' });
      }
      if (displayNameRaw.length > 80) {
        return res.status(400).json({ error: 'displayName must be 80 characters or less' });
      }
    }

    const publicDescriptionRaw = descriptionProvided
      ? String(req.body?.publicDescription || '').trim().slice(0, 500)
      : undefined;

    const tenantId = Number(session.user.tenantId);
    const tenant = await db.get(
      'SELECT slug, display_name, client_preferences_json FROM tenants WHERE id = ? LIMIT 1',
      [tenantId]
    ) as { slug?: string; display_name?: string; client_preferences_json?: string } | undefined;

    if (!tenant) {
      return res.status(404).json({ error: 'Tenant not found' });
    }

    let nextPrefs: Record<string, unknown> = {};
    try {
      nextPrefs = JSON.parse(String(tenant.client_preferences_json || '{}')) || {};
    } catch {
      nextPrefs = {};
    }
    if (typeof nextPrefs !== 'object' || nextPrefs === null || Array.isArray(nextPrefs)) {
      nextPrefs = {};
    }

    if (publicDescriptionRaw !== undefined) {
      if (publicDescriptionRaw) {
        nextPrefs.publicDescription = publicDescriptionRaw;
      } else {
        delete nextPrefs.publicDescription;
      }
    }

    if (displayNameProvided) {
      await db.run(
        `UPDATE tenants
         SET display_name = ?, client_preferences_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [displayNameRaw, JSON.stringify(nextPrefs), tenantId]
      );
      await db.run(
        `UPDATE client_users
         SET full_name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE tenant_id = ? AND status = 'active'`,
        [displayNameRaw, tenantId]
      );
    } else {
      await db.run(
        `UPDATE tenants
         SET client_preferences_json = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [JSON.stringify(nextPrefs), tenantId]
      );
    }

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_profile_update', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify({
        displayName: displayNameProvided ? displayNameRaw : undefined,
        publicDescription: publicDescriptionRaw,
      })]
    );

    invalidatePublicPortfolioCacheForSlug(String(tenant.slug || ''));

    res.json({
      success: true,
      displayName: displayNameProvided ? displayNameRaw : String(tenant.display_name || ''),
      publicDescription: publicDescriptionRaw !== undefined
        ? publicDescriptionRaw
        : String((nextPrefs as { publicDescription?: string }).publicDescription || ''),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client profile update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/client/logout', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (session?.token) {
      await revokeClientSession(session.token);
    }
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client logout error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
router.get('/client/strategy/custom-ts-draft', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const state = await getStrategyClientCustomTsDraft(Number(session.user.tenantId));
    res.json({ success: true, ...state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy custom TS draft read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/client/strategy/custom-ts-draft', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const state = await updateStrategyClientCustomTsDraft(Number(session.user.tenantId), {
      selectedOfferIds: Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      op: toOptionalNumber(req.body?.op),
      assignedApiKeyName: req.body?.assignedApiKeyName !== undefined ? String(req.body.assignedApiKeyName || '').trim() : undefined,
    });

    res.json({ success: true, ...state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client strategy custom TS draft save error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/custom-ts-draft/preview', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const preview = await previewStrategyClientCustomTsDraft(Number(session.user.tenantId), {
      selectedOfferIds: Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      op: toOptionalNumber(req.body?.op),
      assignedApiKeyName: req.body?.assignedApiKeyName !== undefined ? String(req.body.assignedApiKeyName || '').trim() : undefined,
      riskLevel: req.body?.riskLevel,
      tradeFrequencyLevel: req.body?.tradeFrequencyLevel,
      riskScore: toOptionalNumber(req.body?.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body?.tradeFrequencyScore),
    });

    res.json({ success: true, ...preview });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/strategy/custom-ts-systems', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const data = await listClientCustomTsSystemsState(Number(session.user.tenantId));
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS systems list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/custom-ts-systems/save-from-draft', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const data = await saveClientCustomTsSystemFromDraft(Number(session.user.tenantId), {
      profileName: req.body?.profileName !== undefined ? String(req.body.profileName || '').trim() : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS save-from-draft error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/custom-ts-systems/:profileId/start', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const profileId = Math.max(1, Math.floor(Number(req.params.profileId || 0)));
    if (!Number.isFinite(profileId) || profileId <= 0) {
      return res.status(400).json({ error: 'Invalid profileId' });
    }

    const data = await startClientCustomTsSystem(Number(session.user.tenantId), profileId, {
      assignedApiKeyName: req.body?.assignedApiKeyName !== undefined ? String(req.body.assignedApiKeyName || '').trim() : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/custom-ts-systems/:profileId/stop', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const profileId = Math.max(1, Math.floor(Number(req.params.profileId || 0)));
    if (!Number.isFinite(profileId) || profileId <= 0) {
      return res.status(400).json({ error: 'Invalid profileId' });
    }

    const data = await stopClientCustomTsSystem(Number(session.user.tenantId), profileId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS stop error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/strategy/custom-ts-systems/:profileId/preview', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const profileId = Math.max(1, Math.floor(Number(req.params.profileId || 0)));
    if (!Number.isFinite(profileId) || profileId <= 0) {
      return res.status(400).json({ error: 'Invalid profileId' });
    }

    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const data = await previewClientCustomTsSystemById(Number(session.user.tenantId), profileId, {
      riskLevel: req.body?.riskLevel,
      tradeFrequencyLevel: req.body?.tradeFrequencyLevel,
      riskScore: toOptionalNumber(req.body?.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body?.tradeFrequencyScore),
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client custom TS profile preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/catalog', authenticateClient, async (_req, res) => {
  try {
    await initResearchDb();
    const offerIds = await listOfferIds();

    const items = await Promise.all(
      offerIds.map(async (offerId) => {
        const preset = await getPreset(offerId, 'medium', 'medium');
        return {
          offerId,
          defaultRisk: 'medium',
          defaultFreq: 'medium',
          metrics: preset?.metrics || {},
          equity_curve: preset?.equity_curve || [],
          hasPreset: !!preset,
        };
      })
    );

    res.json({ success: true, offers: items });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client catalog load error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/catalog/:offerId/preset', authenticateClient, async (req, res) => {
  try {
    const offerId = String(req.params.offerId || '').trim();
    if (!offerId) {
      return res.status(400).json({ error: 'offerId is required' });
    }

    const risk = String(req.query.risk || 'medium').trim().toLowerCase();
    const freq = String(req.query.freq || 'medium').trim().toLowerCase();
    if (!isLevel3(risk)) {
      return res.status(400).json({ error: 'risk must be one of: low | medium | high' });
    }
    if (!isLevel3(freq)) {
      return res.status(400).json({ error: 'freq must be one of: low | medium | high' });
    }

    await initResearchDb();
    const preset = await getPreset(offerId, risk, freq);
    if (!preset) {
      return res.status(404).json({ error: `Preset not found for offerId=${offerId} risk=${risk} freq=${freq}` });
    }

    res.json({
      success: true,
      offerId,
      risk,
      freq,
      ...preset,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client preset load error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/algofund/state', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const state = await getAlgofundState(
      Number(session.user.tenantId),
      toOptionalNumber(req.query.riskMultiplier),
      false
    );

    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client algofund workspace state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/client/algofund/profile', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const state = await updateAlgofundState(Number(session.user.tenantId), {
      riskMultiplier: toOptionalNumber(req.body?.riskMultiplier),
      assignedApiKeyName: req.body?.assignedApiKeyName !== undefined ? String(req.body.assignedApiKeyName || '').trim() : undefined,
      requestedEnabled: toOptionalBool(req.body?.requestedEnabled),
    });

    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client algofund profile save error: ${err.message}`);
    res.status(resolveClientWorkspaceErrorStatus(err.message)).json({ error: err.message });
  }
});

router.post('/client/algofund/request', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const requestTypeRaw = String(req.body?.requestType || '').trim().toLowerCase();
    const requestType = requestTypeRaw === 'stop'
      ? 'stop'
      : requestTypeRaw === 'switch_system'
        ? 'switch_system'
        : 'start';
    const tenantId = Number(session.user.tenantId);
    const executionApiKeyName = req.body?.executionApiKeyName ? String(req.body.executionApiKeyName).trim() : '';
    if (executionApiKeyName && !executionApiKeyName.startsWith(`tenant-${tenantId}-`)) {
      return res.status(403).json({ error: 'executionApiKeyName is not owned by current tenant' });
    }

    const state = await requestAlgofundAction(
      tenantId,
      requestType,
      String(req.body?.note || ''),
      {
        targetSystemId: toOptionalNumber(req.body?.targetSystemId),
        targetSystemName: req.body?.targetSystemName ? String(req.body.targetSystemName) : undefined,
        executionApiKeyName: executionApiKeyName || undefined,
      }
    );

    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client algofund action request error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/algofund/connect-portfolio', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }
    const tenantId = Number(session.user.tenantId);
    const executionApiKeyName = req.body?.executionApiKeyName ? String(req.body.executionApiKeyName).trim() : '';
    if (executionApiKeyName && !executionApiKeyName.startsWith(`tenant-${tenantId}-`)) {
      return res.status(403).json({ error: 'executionApiKeyName is not owned by current tenant' });
    }
    if (executionApiKeyName) {
      await updateAlgofundState(tenantId, { assignedApiKeyName: executionApiKeyName, requestedEnabled: true }).catch(() => null);
    }
    const result = await materializeAlgofundPortfolioFull({
      tenantId,
      portfolioId: req.body?.portfolioId != null ? Number(req.body.portfolioId) : undefined,
      setKey: req.body?.setKey != null ? String(req.body.setKey) : undefined,
      activate: true,
    });
    const state = await getAlgofundState(tenantId);
    res.json({ success: true, ...result, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client algofund connect-portfolio error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/api-key', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const exchange = String(req.body?.exchange || '').trim().toLowerCase();
    const apiKey = String(req.body?.apiKey || '').trim();
    const secret = String(req.body?.secret || '').trim();
    const passphrase = String(req.body?.passphrase || '').trim();
    const testnet = Boolean(req.body?.testnet);
    const demo = Boolean(req.body?.demo);

    if (!exchange) {
      return res.status(400).json({ error: 'exchange is required' });
    }
    if (!apiKey || !secret) {
      return res.status(400).json({ error: 'apiKey and secret are required' });
    }
    if (exchangeRequiresPassphrase(exchange) && !passphrase) {
      return res.status(400).json({ error: 'passphrase is required for this exchange' });
    }

    const tenantId = Number(session.user.tenantId);
    const suffix = Math.random().toString(36).slice(2, 8);
    const keyName = `tenant-${tenantId}-${exchange}-${suffix}`;

    await saveApiKey({
      name: keyName,
      exchange,
      api_key: apiKey,
      secret,
      passphrase,
      speed_limit: 10,
      testnet,
      demo,
    });

    try {
      await ensureExchangeClientInitialized(keyName);
    } catch (initErr) {
      logger.warn(`Client api key saved but exchange init failed for ${keyName}: ${(initErr as Error).message}`);
    }

    // First key becomes the tenant monitoring key (does not start trading).
    const tenantRow = await db.get(
      'SELECT assigned_api_key_name FROM tenants WHERE id = ?',
      [tenantId]
    ) as { assigned_api_key_name?: string } | undefined;
    if (!String(tenantRow?.assigned_api_key_name || '').trim()) {
      await db.run(
        `UPDATE tenants
         SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [keyName, tenantId]
      );
    }

    return res.json({
      success: true,
      keyName,
      productMode: session.user.productMode,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key save error: ${err.message}`);
    res.status(resolveClientWorkspaceErrorStatus(err.message)).json({ error: err.message });
  }
});

router.get('/client/api-keys', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const tenantPrefix = `tenant-${tenantId}-`;
    const rows = await db.all(
      `SELECT id, name, exchange, testnet, demo, created_at, updated_at
       FROM api_keys
       WHERE name LIKE ?
       ORDER BY id DESC`,
      [`${tenantPrefix}%`]
    ) as Array<Record<string, unknown>>;

    const [tenant, strategyProfile, algofundProfile, customDraft] = await Promise.all([
      db.get(
        'SELECT assigned_api_key_name FROM tenants WHERE id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name FROM strategy_client_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name, execution_api_key_name FROM algofund_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string; execution_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name FROM strategy_client_custom_ts_drafts WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string } | undefined>,
    ]);
    const assignedName = String(tenant?.assigned_api_key_name || '').trim();
    const strategyAssignedName = String(strategyProfile?.assigned_api_key_name || '').trim();
    const algofundAssignedName = String(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name || '').trim();
    const customTsAssignedName = String(customDraft?.assigned_api_key_name || '').trim();

    res.json({
      success: true,
      assignedApiKeyName: assignedName,
      strategyAssignedApiKeyName: strategyAssignedName,
      algofundAssignedApiKeyName: algofundAssignedName,
      customTsAssignedApiKeyName: customTsAssignedName,
      keys: (rows || []).map((row) => ({
        id: Number(row.id || 0),
        name: String(row.name || ''),
        exchange: String(row.exchange || ''),
        testnet: Boolean(row.testnet),
        demo: Boolean(row.demo),
        createdAt: String(row.created_at || ''),
        updatedAt: String(row.updated_at || ''),
        isAssigned: String(row.name || '') === assignedName,
        usedByStrategy: String(row.name || '') === strategyAssignedName,
        usedByAlgofund: String(row.name || '') === algofundAssignedName,
        usedByCustomTs: String(row.name || '') === customTsAssignedName,
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/client/api-keys/:id', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const apiKeyId = Number.parseInt(String(req.params.id || '0'), 10);
    if (!Number.isFinite(apiKeyId) || apiKeyId <= 0) {
      return res.status(400).json({ error: 'Invalid API key id' });
    }

    const row = await db.get(
      'SELECT id, name FROM api_keys WHERE id = ?',
      [apiKeyId]
    ) as { id?: number; name?: string } | undefined;

    if (!row?.id) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const keyName = String(row.name || '').trim();
    if (!keyName.startsWith(`tenant-${tenantId}-`)) {
      return res.status(403).json({ error: 'API key is not owned by current tenant' });
    }

    const exchange = String(req.body?.exchange || '').trim().toLowerCase();
    const apiKey = String(req.body?.apiKey || '').trim();
    const secret = String(req.body?.secret || '').trim();
    const passphrase = String(req.body?.passphrase || '').trim();
    const testnet = Boolean(req.body?.testnet);
    const demo = Boolean(req.body?.demo);

    if (!exchange) {
      return res.status(400).json({ error: 'exchange is required' });
    }
    if (!apiKey || !secret) {
      return res.status(400).json({ error: 'apiKey and secret are required' });
    }
    if (exchangeRequiresPassphrase(exchange) && !passphrase) {
      return res.status(400).json({ error: 'passphrase is required for this exchange' });
    }

    await db.run(
      `UPDATE api_keys
       SET exchange = ?, api_key = ?, secret = ?, passphrase = ?, testnet = ?, demo = ?
       WHERE id = ?`,
      [exchange, apiKey, secret, passphrase, testnet ? 1 : 0, demo ? 1 : 0, apiKeyId]
    );
    removeExchangeClient(keyName);
    try {
      await ensureExchangeClientInitialized(keyName);
    } catch (initErr) {
      logger.warn(`Client api key updated but exchange re-init failed for ${keyName}: ${(initErr as Error).message}`);
    }

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_api_key_update', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify({ apiKeyId, keyName, exchange, testnet, demo })]
    );

    res.json({ success: true, id: apiKeyId, name: keyName });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key update error: ${err.message}`);
    res.status(resolveClientWorkspaceErrorStatus(err.message)).json({ error: err.message });
  }
});

router.delete('/client/api-keys/:id', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const apiKeyId = Number.parseInt(String(req.params.id || '0'), 10);
    if (!Number.isFinite(apiKeyId) || apiKeyId <= 0) {
      return res.status(400).json({ error: 'Invalid API key id' });
    }

    const row = await db.get(
      'SELECT id, name FROM api_keys WHERE id = ?',
      [apiKeyId]
    ) as { id?: number; name?: string } | undefined;

    if (!row?.id) {
      return res.status(404).json({ error: 'API key not found' });
    }

    const keyName = String(row.name || '').trim();
    if (!keyName.startsWith(`tenant-${tenantId}-`)) {
      return res.status(403).json({ error: 'API key is not owned by current tenant' });
    }

    const [tenant, strategyProfile, algofundProfile, customDraft] = await Promise.all([
      db.get('SELECT assigned_api_key_name FROM tenants WHERE id = ?', [tenantId]) as Promise<{ assigned_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name, requested_enabled, actual_enabled FROM strategy_client_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string; requested_enabled?: number; actual_enabled?: number } | undefined>,
      db.get(
        'SELECT assigned_api_key_name, execution_api_key_name, requested_enabled, actual_enabled FROM algofund_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string; execution_api_key_name?: string; requested_enabled?: number; actual_enabled?: number } | undefined>,
      db.get(
        'SELECT assigned_api_key_name, selected_offer_ids_json FROM strategy_client_custom_ts_drafts WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string; selected_offer_ids_json?: string } | undefined>,
    ]);

    const tenantAssignedKey = String(tenant?.assigned_api_key_name || '').trim();
    const strategyAssignedKey = String(strategyProfile?.assigned_api_key_name || '').trim();
    const strategyEnabled = Number(strategyProfile?.requested_enabled || 0) === 1 || Number(strategyProfile?.actual_enabled || 0) === 1;
    const algofundAssignedKey = String(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name || '').trim();
    const algofundEnabled = Number(algofundProfile?.requested_enabled || 0) === 1 || Number(algofundProfile?.actual_enabled || 0) === 1;
    const customAssignedKey = String(customDraft?.assigned_api_key_name || '').trim();
    const customSelectedOffers = JSON.parse(String(customDraft?.selected_offer_ids_json || '[]')) as unknown[];

    if (strategyAssignedKey === keyName && strategyEnabled) {
      return res.status(409).json({ error: 'API-ключ сейчас используется активным потоком Стратегий. Сначала выключите поток или снимите привязку ключа.' });
    }

    if (algofundAssignedKey === keyName && algofundEnabled) {
      return res.status(409).json({ error: 'API-ключ сейчас используется активным потоком Алгофонда. Сначала выключите поток или снимите привязку ключа.' });
    }

    if (strategyAssignedKey === keyName) {
      await updateStrategyClientState(tenantId, { assignedApiKeyName: '', requestedEnabled: false });
    }

    if (algofundAssignedKey === keyName) {
      await updateAlgofundState(tenantId, { assignedApiKeyName: '', requestedEnabled: false });
    }

    if (customAssignedKey === keyName) {
      await updateStrategyClientCustomTsDraft(tenantId, { assignedApiKeyName: '' });
    }

    if (tenantAssignedKey === keyName && strategyAssignedKey !== keyName && algofundAssignedKey !== keyName) {
      await db.run(
        `UPDATE tenants
         SET assigned_api_key_name = '', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [tenantId]
      );
    }

    await db.run('DELETE FROM risk_settings WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM strategies WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM monitoring_snapshots WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM api_keys WHERE id = ?', [apiKeyId]);
    removeExchangeClient(keyName);

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_api_key_delete', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify({ apiKeyId, keyName, detachedFromStrategy: strategyAssignedKey === keyName, detachedFromAlgofund: algofundAssignedKey === keyName, detachedFromCustomTs: customAssignedKey === keyName, customDraftOffersCount: Array.isArray(customSelectedOffers) ? customSelectedOffers.length : 0 })]
    );

    res.json({ success: true, id: apiKeyId, name: keyName });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key delete error: ${err.message}`);
    res.status(resolveClientWorkspaceErrorStatus(err.message)).json({ error: err.message });
  }
});

router.get('/client/tariff', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId || !session?.user?.productMode) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const productMode = String(session.user.productMode);

    const currentPlan = await db.get(
      `SELECT p.code, p.title, p.product_mode, p.price_usdt, p.max_deposit_total, p.max_strategies_total, p.risk_cap_max,
              p.allow_ts_start_stop_requests, p.features_json
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [tenantId]
    ) as Record<string, unknown> | undefined;

    let currentStrategyPlan: Record<string, unknown> | undefined;
    let currentAlgofundPlan: Record<string, unknown> | undefined;
    if (productMode === 'dual') {
      currentStrategyPlan = await db.get(
        `SELECT p.code, p.title, p.product_mode, p.price_usdt, p.max_deposit_total, p.max_strategies_total, p.risk_cap_max,
                p.allow_ts_start_stop_requests, p.features_json
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.tenant_id = ? AND p.product_mode = 'strategy_client'
         ORDER BY s.id DESC LIMIT 1`,
        [tenantId]
      ) as Record<string, unknown> | undefined;
      currentAlgofundPlan = await db.get(
        `SELECT p.code, p.title, p.product_mode, p.price_usdt, p.max_deposit_total, p.max_strategies_total, p.risk_cap_max,
                p.allow_ts_start_stop_requests, p.features_json
         FROM subscriptions s JOIN plans p ON p.id = s.plan_id
         WHERE s.tenant_id = ? AND p.product_mode = 'algofund_client'
         ORDER BY s.id DESC LIMIT 1`,
        [tenantId]
      ) as Record<string, unknown> | undefined;
    }

    const availablePlans = await db.all(
      productMode === 'dual'
        ? `SELECT code, title, product_mode, price_usdt, original_price_usdt, max_deposit_total, max_strategies_total, risk_cap_max,
                  allow_ts_start_stop_requests, features_json
           FROM plans
           WHERE is_active = 1 AND product_mode IN ('strategy_client', 'algofund_client')
           ORDER BY price_usdt ASC, id ASC`
        : `SELECT code, title, product_mode, price_usdt, original_price_usdt, max_deposit_total, max_strategies_total, risk_cap_max,
                  allow_ts_start_stop_requests, features_json
           FROM plans
           WHERE is_active = 1 AND product_mode = ?
           ORDER BY price_usdt ASC, id ASC`,
      productMode === 'dual' ? [] : [productMode]
    ) as Array<Record<string, unknown>>;

    const requests = await db.all(
      `SELECT id, action, payload_json, created_at
       FROM saas_audit_log
       WHERE tenant_id = ? AND action = 'client_tariff_request'
       ORDER BY id DESC
       LIMIT 30`,
      [tenantId]
    ) as Array<Record<string, unknown>>;

    res.json({
      success: true,
      productMode,
      currentPlan: currentPlan || null,
      currentStrategyPlan: currentStrategyPlan || null,
      currentAlgofundPlan: currentAlgofundPlan || null,
      availablePlans: availablePlans || [],
      requests: (requests || []).map((item) => ({
        id: Number(item.id || 0),
        createdAt: String(item.created_at || ''),
        payload: (() => {
          try {
            return JSON.parse(String(item.payload_json || '{}'));
          } catch {
            return {};
          }
        })(),
      })),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client tariff load error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/client/tariff/request', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId || !session?.user?.productMode) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const productMode = String(session.user.productMode);
    const targetPlanCode = String(req.body?.targetPlanCode || '').trim();
    const note = String(req.body?.note || '').trim().slice(0, 500);

    if (!targetPlanCode) {
      return res.status(400).json({ error: 'targetPlanCode is required' });
    }

    const targetPlan = await db.get(
      'SELECT code, title, product_mode FROM plans WHERE code = ? AND is_active = 1 LIMIT 1',
      [targetPlanCode]
    ) as { code?: string; title?: string; product_mode?: string } | undefined;

    if (!targetPlan?.code) {
      return res.status(404).json({ error: 'Target plan not found' });
    }
    if (String(targetPlan.product_mode || '') !== productMode && productMode !== 'dual') {
      return res.status(400).json({ error: 'Target plan belongs to another product mode' });
    }

    const currentSubscription = await db.get(
      `SELECT started_at
       FROM subscriptions
       WHERE tenant_id = ?
       ORDER BY id DESC
       LIMIT 1`,
      [tenantId]
    ) as { started_at?: string } | undefined;

    const currentPlan = await db.get(
      `SELECT p.product_mode
       FROM subscriptions s
       JOIN plans p ON p.id = s.plan_id
       WHERE s.tenant_id = ?
       ORDER BY s.id DESC
       LIMIT 1`,
      [tenantId]
    ) as { product_mode?: string } | undefined;

    const tenantApiKey = await db.get(
      'SELECT assigned_api_key_name FROM tenants WHERE id = ? LIMIT 1',
      [tenantId]
    ) as { assigned_api_key_name?: string } | undefined;

    const startedAt = currentSubscription?.started_at ? new Date(currentSubscription.started_at) : new Date();
    const nextBillingCycleAt = new Date(startedAt);
    nextBillingCycleAt.setMonth(nextBillingCycleAt.getMonth() + 1);

    const latestMonitoring = tenantApiKey?.assigned_api_key_name
      ? await getMonitoringLatest(String(tenantApiKey.assigned_api_key_name)).catch(() => null)
      : null;
    const hwmSnapshot = {
      capturedAt: new Date().toISOString(),
      equityUsd: Number((latestMonitoring as any)?.equity_usd || 0),
      drawdownPct: Number((latestMonitoring as any)?.drawdown_pct || 0),
      source: latestMonitoring ? 'monitoring_latest' : 'none',
    };

    const payload = {
      targetPlanCode: targetPlan.code,
      targetPlanTitle: String(targetPlan.title || targetPlan.code),
      note,
      billingSwitchPolicy: {
        singleActiveModePerBillingPeriod: true,
        effectiveFromNextBillingCycle: true,
        nextBillingCycleAt: nextBillingCycleAt.toISOString(),
        currentMode: String(currentPlan?.product_mode || productMode),
        targetMode: String(targetPlan.product_mode || productMode),
      },
      hwmSnapshot,
    };

    const insert = await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_tariff_request', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify(payload)]
    );

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_billing_mode_switch_requested', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify(payload)]
    );

    res.json({
      success: true,
      request: {
        id: Number((insert as any)?.lastID || 0),
        ...payload,
      },
      switchPolicyMessage: 'Смена режима будет применена с начала следующего billing-cycle. В текущем расчетном периоде активен только один режим. HWM-снимок зафиксирован и событие записано в аудит.',
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client tariff request error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/client/monitoring', authenticateClient, async (req, res) => {
  try {
    const session = (req as any).clientAuth;
    if (!session?.user?.tenantId) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    const tenantId = Number(session.user.tenantId);
    const limitRaw = Number.parseInt(String(req.query.limit || '120'), 10);
    const limit = Math.min(500, Math.max(10, Number.isFinite(limitRaw) ? limitRaw : 120));
    const daysRaw = Number.parseInt(String(req.query.days || '0'), 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 0;
    const allPeriod = String(req.query.all || '0') === '1'
      || String(req.query.all || '').toLowerCase() === 'true';
    const includeTrades = String(req.query.includeTrades || '0') === '1'
      || String(req.query.includeTrades || '').toLowerCase() === 'true';
    const includeTradesRows = String(req.query.includeTradesRows || '0') === '1'
      || String(req.query.includeTradesRows || '').toLowerCase() === 'true';
    const includeTradeMarkers = String(req.query.includeTradeMarkers || '0') === '1'
      || String(req.query.includeTradeMarkers || '').toLowerCase() === 'true';
    const capture = String(req.query.capture || '0') === '1'
      || String(req.query.capture || '').toLowerCase() === 'true';

    const requestedMode = String(req.query.mode || '').trim().toLowerCase();
    const productMode = String(session.user?.productMode || '').trim().toLowerCase();
    const [tenant, strategyProfile, algofundProfile, tvAlertsProfile, fallbackKey] = await Promise.all([
      db.get(
        'SELECT assigned_api_key_name FROM tenants WHERE id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name FROM strategy_client_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string } | undefined>,
      db.get(
        'SELECT assigned_api_key_name, execution_api_key_name FROM algofund_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ assigned_api_key_name?: string; execution_api_key_name?: string } | undefined>,
      db.get(
        'SELECT default_api_key_name FROM tv_alerts_profiles WHERE tenant_id = ?',
        [tenantId]
      ) as Promise<{ default_api_key_name?: string } | undefined>,
      db.get(
        `SELECT name FROM api_keys
         WHERE name LIKE ?
         ORDER BY id DESC
         LIMIT 1`,
        [`tenant-${tenantId}-%`]
      ) as Promise<{ name?: string } | undefined>,
    ]);

    const tenantApiKeyName = String(tenant?.assigned_api_key_name || '').trim();
    const strategyApiKeyName = String(strategyProfile?.assigned_api_key_name || '').trim();
    const algofundApiKeyName = String(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name || '').trim();
    const tvAlertsApiKeyName = String(tvAlertsProfile?.default_api_key_name || '').trim();
    const fallbackApiKeyName = String(fallbackKey?.name || '').trim();

    const resolveApiKeyName = () => {
      if (productMode === 'tv_alerts_client') {
        return tvAlertsApiKeyName || tenantApiKeyName || strategyApiKeyName || algofundApiKeyName || fallbackApiKeyName;
      }
      if (requestedMode === 'algofund') {
        return algofundApiKeyName || strategyApiKeyName || tenantApiKeyName || fallbackApiKeyName;
      }
      if (requestedMode === 'strategy') {
        return strategyApiKeyName || algofundApiKeyName || tenantApiKeyName || fallbackApiKeyName;
      }
      return strategyApiKeyName || algofundApiKeyName || tvAlertsApiKeyName || tenantApiKeyName || fallbackApiKeyName;
    };

    const apiKeyName = resolveApiKeyName();
    if (!apiKeyName) {
      return res.json({
        success: true,
        apiKeyName: '',
        latest: null,
        points: [],
        streams: {
          strategy: { apiKeyName: strategyApiKeyName, latest: null, points: [] },
          algofund: { apiKeyName: algofundApiKeyName, latest: null, points: [] },
        },
      });
    }

    // Keep tenant assigned for monitoring even if client only saved a key (no trading start).
    if (!tenantApiKeyName && apiKeyName) {
      await db.run(
        `UPDATE tenants
         SET assigned_api_key_name = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND TRIM(COALESCE(assigned_api_key_name, '')) = ''`,
        [apiKeyName, tenantId]
      ).catch(() => undefined);
    }

    const loadStream = async (targetApiKeyName: string, allowCapture: boolean = false) => {
      const safeName = String(targetApiKeyName || '').trim();
      if (!safeName) {
        return {
          apiKeyName: '',
          latest: null,
          points: [] as any[],
          periodStats: null,
          tradeStats: undefined,
          trades: undefined,
        };
      }
      if (allowCapture && capture) {
        try {
          await recordMonitoringSnapshot(safeName);
        } catch (snapError) {
          logger.warn(`Client monitoring capture failed for ${safeName}: ${(snapError as Error).message}`);
        }
      }
      const bundle = await getMonitoringBundle(safeName, {
        limit,
        days,
        all: allPeriod,
        includeTrades,
        includeTradesRows,
        includeTradeMarkers,
      });
      return {
        apiKeyName: safeName,
        ...bundle,
      };
    };

    const [selectedStream, strategyStream, algofundStream] = await Promise.all([
      loadStream(apiKeyName, true),
      loadStream(strategyApiKeyName, false),
      loadStream(algofundApiKeyName, false),
    ]);

    res.json({
      success: true,
      apiKeyName: selectedStream.apiKeyName,
      latest: selectedStream.latest,
      points: selectedStream.points,
      periodStats: selectedStream.periodStats,
      tradeStats: selectedStream.tradeStats,
      trades: selectedStream.trades,
      streams: {
        strategy: strategyStream,
        algofund: algofundStream,
      },
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client monitoring load error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

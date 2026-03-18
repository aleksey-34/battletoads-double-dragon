import { Router } from 'express';
import logger from '../utils/logger';
import { createClientMagicLink } from '../utils/auth';
import {
  getAlgofundState,
  getSaasAdminSummary,
  getStrategyClientState,
  materializeStrategyClient,
  previewStrategyClientSelection,
  previewStrategyClientOffer,
  publishAdminTradingSystem,
  requestAlgofundAction,
  resolveAlgofundRequest,
  seedDemoSaasData,
  updatePlanAdminState,
  updateAlgofundState,
  updateTenantAdminState,
  updateStrategyClientState,
} from '../saas/service';

const router = Router();

const toBool = (value: unknown, fallback = false): boolean => {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  const text = String(value).trim().toLowerCase();
  return text === '1' || text === 'true' || text === 'yes' || text === 'on';
};

const toOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const isLevel3 = (value: unknown): value is 'low' | 'medium' | 'high' => {
  return value === 'low' || value === 'medium' || value === 'high';
};

router.get('/admin/summary', async (_req, res) => {
  try {
    const data = await getSaasAdminSummary();
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS admin summary error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/seed', async (_req, res) => {
  try {
    const data = await seedDemoSaasData();
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS seed error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/publish', async (_req, res) => {
  try {
    const data = await publishAdminTradingSystem();
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS publish admin TS error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/tenants/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const tenants = await updateTenantAdminState(tenantId, {
      displayName: req.body.displayName,
      status: req.body.status,
      assignedApiKeyName: req.body.assignedApiKeyName,
      planCode: req.body.planCode,
    });
    res.json({ success: true, tenants });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS tenant admin update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/tenants/:tenantId/magic-link', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const result = await createClientMagicLink(tenantId, {
      ip: String(req.ip || ''),
      userAgent: String(req.headers['user-agent'] || ''),
    }, String(req.body?.note || ''));
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS magic link error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/plans/:planCode', async (req, res) => {
  const planCode = String(req.params.planCode || '').trim();
  if (!planCode) {
    return res.status(400).json({ error: 'Invalid planCode' });
  }

  try {
    const plans = await updatePlanAdminState(planCode, {
      title: req.body.title,
      priceUsdt: toOptionalNumber(req.body.priceUsdt),
      maxDepositTotal: toOptionalNumber(req.body.maxDepositTotal),
      riskCapMax: toOptionalNumber(req.body.riskCapMax),
      maxStrategiesTotal: toOptionalNumber(req.body.maxStrategiesTotal),
      allowTsStartStopRequests: req.body.allowTsStartStopRequests !== undefined
        ? toBool(req.body.allowTsStartStopRequests)
        : undefined,
    });
    res.json({ success: true, plans });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS plan admin update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategy-clients/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await getStrategyClientState(tenantId);
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy client state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/strategy-clients/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
      return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
    }
    if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
      return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
    }

    const data = await updateStrategyClientState(tenantId, {
      selectedOfferIds: Array.isArray(req.body.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      riskLevel: req.body.riskLevel,
      tradeFrequencyLevel: req.body.tradeFrequencyLevel,
      assignedApiKeyName: req.body.assignedApiKeyName,
      requestedEnabled: req.body.requestedEnabled !== undefined ? toBool(req.body.requestedEnabled) : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy client update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategy-clients/:tenantId/preview', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  if (!req.body.offerId) {
    return res.status(400).json({ error: 'offerId is required' });
  }
  if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
    return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
  }
  if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
    return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
  }

  try {
    const data = await previewStrategyClientOffer(
      tenantId,
      String(req.body.offerId),
      req.body.riskLevel,
      req.body.tradeFrequencyLevel,
      toOptionalNumber(req.body.riskScore),
      toOptionalNumber(req.body.tradeFrequencyScore)
    );
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy client preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategy-clients/:tenantId/selection-preview', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  if (req.body?.riskLevel !== undefined && !isLevel3(req.body.riskLevel)) {
    return res.status(400).json({ error: 'riskLevel must be one of: low | medium | high' });
  }
  if (req.body?.tradeFrequencyLevel !== undefined && !isLevel3(req.body.tradeFrequencyLevel)) {
    return res.status(400).json({ error: 'tradeFrequencyLevel must be one of: low | medium | high' });
  }

  try {
    const data = await previewStrategyClientSelection(tenantId, {
      selectedOfferIds: Array.isArray(req.body.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      riskLevel: req.body.riskLevel,
      tradeFrequencyLevel: req.body.tradeFrequencyLevel,
      riskScore: toOptionalNumber(req.body.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body.tradeFrequencyScore),
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy client selection preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategy-clients/:tenantId/materialize', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await materializeStrategyClient(tenantId, toBool(req.body.activate, true));
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy client materialize error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/algofund/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await getAlgofundState(
      tenantId,
      toOptionalNumber(req.query.riskMultiplier),
      toBool(req.query.allowPreviewAbovePlan)
    );
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/algofund/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await updateAlgofundState(tenantId, {
      riskMultiplier: toOptionalNumber(req.body.riskMultiplier),
      assignedApiKeyName: req.body.assignedApiKeyName,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/algofund/:tenantId/request', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  const requestType = req.body.requestType === 'stop' ? 'stop' : 'start';

  try {
    const data = await requestAlgofundAction(tenantId, requestType, String(req.body.note || ''));
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund request error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/algofund/requests/:requestId/resolve', async (req, res) => {
  const requestId = Number(req.params.requestId);
  if (!Number.isFinite(requestId)) {
    return res.status(400).json({ error: 'Invalid requestId' });
  }

  const status = req.body.status === 'rejected' ? 'rejected' : 'approved';

  try {
    const data = await resolveAlgofundRequest(requestId, status, String(req.body.decisionNote || ''));
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund resolve error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

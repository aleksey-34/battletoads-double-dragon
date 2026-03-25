import { Router } from 'express';
import logger from '../utils/logger';
import { createClientMagicLink } from '../utils/auth';
import { runAdminTelegramReportNow } from '../notifications/adminTelegramReporter';
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
  retryMaterializeAlgofundSystem,
  seedDemoSaasData,
  updatePlanAdminState,
  updateAlgofundState,
  updateTenantAdminState,
  updateStrategyClientState,
  createTenantByAdmin,
  getAdminLowLotRecommendations,
  applyLowLotRecommendation,
  getAdminTelegramControls,
  updateAdminTelegramControls,
  getOfferStoreAdminState,
  analyzeOfferUnpublishImpact,
  updateOfferStoreAdminState,
  getAdminReportSettings,
  updateAdminReportSettings,
  getAdminPerformanceReport,
  previewAdminSweepBacktest,
  listStrategyClientSystemProfilesState,
  createStrategyClientSystemProfile,
  updateStrategyClientSystemProfile,
  deleteStrategyClientSystemProfile,
  activateStrategyClientSystemProfileById,
  requestAlgofundBatchAction,
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

router.get('/admin/summary', async (req, res) => {
  try {
    const scope = String(req.query.scope || 'full').trim().toLowerCase();
    const includeOfferStore = scope !== 'light';
    const data = await getSaasAdminSummary({ includeOfferStore });
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

router.get('/admin/low-lot-recommendations', async (req, res) => {
  try {
    const hours = toOptionalNumber(req.query.hours);
    const limit = toOptionalNumber(req.query.limit);
    const perStrategyReplacementLimit = toOptionalNumber(req.query.perStrategyReplacementLimit);
    const data = await getAdminLowLotRecommendations({
      hours,
      limit,
      perStrategyReplacementLimit,
    });
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS low-lot recommendations error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/telegram-controls', async (_req, res) => {
  try {
    const data = await getAdminTelegramControls();
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS telegram controls read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/telegram-controls', async (req, res) => {
  try {
    const data = await updateAdminTelegramControls({
      adminEnabled: req.body?.adminEnabled !== undefined ? toBool(req.body.adminEnabled) : undefined,
      clientsEnabled: req.body?.clientsEnabled !== undefined ? toBool(req.body.clientsEnabled) : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS telegram controls update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/offer-store', async (_req, res) => {
  try {
    const data = await getOfferStoreAdminState();
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS offer-store read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/offer-store/unpublish-impact/:offerId', async (req, res) => {
  try {
    const offerId = String(req.params.offerId || '').trim();
    if (!offerId) {
      return res.status(400).json({ error: 'offerId is required' });
    }
    const data = await analyzeOfferUnpublishImpact(offerId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS offer-store unpublish-impact error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/offer-store', async (req, res) => {
  try {
    const data = await updateOfferStoreAdminState({
      defaults: req.body?.defaults,
      publishedOfferIds: Array.isArray(req.body?.publishedOfferIds) ? req.body.publishedOfferIds.map(String) : undefined,
      reviewSnapshotPatch: req.body?.reviewSnapshotPatch && typeof req.body.reviewSnapshotPatch === 'object'
        ? req.body.reviewSnapshotPatch
        : undefined,
      tsBacktestSnapshotPatch: req.body?.tsBacktestSnapshotPatch === null
        ? null
        : (req.body?.tsBacktestSnapshotPatch && typeof req.body.tsBacktestSnapshotPatch === 'object'
          ? req.body.tsBacktestSnapshotPatch
          : undefined),
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS offer-store update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/sweep-backtest-preview', async (req, res) => {
  try {
    const data = await previewAdminSweepBacktest({
      kind: req.body?.kind === 'algofund-ts' ? 'algofund-ts' : 'offer',
      offerId: req.body?.offerId ? String(req.body.offerId) : undefined,
      offerIds: Array.isArray(req.body?.offerIds) ? req.body.offerIds.map((item: unknown) => String(item)) : undefined,
      riskScore: toOptionalNumber(req.body?.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body?.tradeFrequencyScore),
      initialBalance: toOptionalNumber(req.body?.initialBalance),
      riskScaleMaxPercent: toOptionalNumber(req.body?.riskScaleMaxPercent),
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS admin sweep backtest preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/reports/settings', async (_req, res) => {
  try {
    const data = await getAdminReportSettings();
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS report settings read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/admin/reports/settings', async (req, res) => {
  try {
    const data = await updateAdminReportSettings(req.body || {});
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS report settings update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/reports/performance', async (req, res) => {
  try {
    const periodRaw = String(req.query.period || '').trim().toLowerCase();
    const period = periodRaw === 'weekly' || periodRaw === 'monthly' ? periodRaw : 'daily';
    const data = await getAdminPerformanceReport(period);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS performance report error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/apply-low-lot-recommendation', async (req, res) => {
  try {
    const strategyId = toOptionalNumber(req.body?.strategyId);
    if (!strategyId) {
      return res.status(400).json({ error: 'strategyId is required' });
    }
    const data = await applyLowLotRecommendation({
      strategyId,
      applyDepositFix: toBool(req.body?.applyDepositFix, false),
      applyLotFix: toBool(req.body?.applyLotFix, false),
      replacementSymbol: req.body?.replacementSymbol ? String(req.body.replacementSymbol).trim() : undefined,
    });
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS apply-low-lot-recommendation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/reports/send-telegram', async (_req, res) => {
  try {
    await runAdminTelegramReportNow({ periodHours: 24 });
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS send telegram report error: ${err.message}`);
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

router.post('/admin/tenants', async (req, res) => {
  const { displayName, productMode, planCode, assignedApiKeyName, language, email, fullName } = req.body;
  if (!displayName || !productMode || !planCode) {
    return res.status(400).json({ error: 'displayName, productMode, and planCode are required' });
  }
  try {
    const tenants = await createTenantByAdmin({
      displayName: String(displayName),
      productMode,
      planCode: String(planCode),
      assignedApiKeyName: assignedApiKeyName ? String(assignedApiKeyName) : undefined,
      language: language ? String(language) : undefined,
      email: email ? String(email) : undefined,
      fullName: fullName ? String(fullName) : undefined,
    });
    res.json({ success: true, tenants });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS create tenant error: ${err.message}`);
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

router.post('/admin/algofund-batch-actions', async (req, res) => {
  try {
    const tenantIds = Array.isArray(req.body?.tenantIds) ? req.body.tenantIds.map((item: unknown) => Number(item)) : [];
    const requestTypeRaw = String(req.body?.requestType || '').trim().toLowerCase();
    const requestType = requestTypeRaw === 'stop'
      ? 'stop'
      : requestTypeRaw === 'switch_system'
        ? 'switch_system'
        : 'start';

    const data = await requestAlgofundBatchAction(
      tenantIds,
      requestType,
      String(req.body?.note || ''),
      {
        targetSystemId: toOptionalNumber(req.body?.targetSystemId),
        targetSystemName: req.body?.targetSystemName ? String(req.body.targetSystemName) : undefined,
      },
      {
        directExecute: Boolean(req.body?.directExecute),
      }
    );
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund batch action error: ${err.message}`);
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

router.get('/strategy-clients/:tenantId/system-profiles', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await listStrategyClientSystemProfilesState(tenantId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy system profiles read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategy-clients/:tenantId/system-profiles', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await createStrategyClientSystemProfile(
      tenantId,
      String(req.body?.profileName || ''),
      Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
      toBool(req.body?.activate, true)
    );
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy system profile create error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/strategy-clients/:tenantId/system-profiles/:profileId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const profileId = Number(req.params.profileId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(profileId)) {
    return res.status(400).json({ error: 'Invalid tenantId/profileId' });
  }

  try {
    const data = await updateStrategyClientSystemProfile(tenantId, profileId, {
      profileName: req.body?.profileName !== undefined ? String(req.body.profileName || '') : undefined,
      selectedOfferIds: Array.isArray(req.body?.selectedOfferIds) ? req.body.selectedOfferIds.map(String) : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy system profile update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/strategy-clients/:tenantId/system-profiles/:profileId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const profileId = Number(req.params.profileId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(profileId)) {
    return res.status(400).json({ error: 'Invalid tenantId/profileId' });
  }

  try {
    const data = await deleteStrategyClientSystemProfile(tenantId, profileId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy system profile delete error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategy-clients/:tenantId/system-profiles/:profileId/activate', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const profileId = Number(req.params.profileId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(profileId)) {
    return res.status(400).json({ error: 'Invalid tenantId/profileId' });
  }

  try {
    const data = await activateStrategyClientSystemProfileById(tenantId, profileId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy system profile activate error: ${err.message}`);
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
      toBool(req.query.allowPreviewAbovePlan),
      toBool(req.query.refreshPreview)
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
      requestedEnabled: req.body.requestedEnabled !== undefined ? toBool(req.body.requestedEnabled) : undefined,
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

  const requestTypeRaw = String(req.body.requestType || '').trim().toLowerCase();
  const requestType = requestTypeRaw === 'stop'
    ? 'stop'
    : requestTypeRaw === 'switch_system'
      ? 'switch_system'
      : 'start';

  try {
    const data = await requestAlgofundAction(
      tenantId,
      requestType,
      String(req.body.note || ''),
      {
        targetSystemId: toOptionalNumber(req.body.targetSystemId),
        targetSystemName: req.body.targetSystemName ? String(req.body.targetSystemName) : undefined,
      }
    );
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

router.post('/algofund/:tenantId/retry-materialize', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await retryMaterializeAlgofundSystem(tenantId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund retry materialize error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

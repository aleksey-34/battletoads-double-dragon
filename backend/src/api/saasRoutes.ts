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
  getHighTradeRecommendations,
  applyLowLotRecommendation,
  getCuratedDraftMembers,
  setCuratedDraftMembers,
  getAdminTelegramControls,
  updateAdminTelegramControls,
  getOfferStoreAdminState,
  analyzeOfferUnpublishImpact,
  updateOfferStoreAdminState,
  getAdminReportSettings,
  updateAdminReportSettings,
  getAdminPerformanceReport,
  getOfferStoreSnapshotRefreshState,
  refreshOfferStoreSnapshotsFromSweep,
  getAlgofundSystemHealthReport,
  getAlgofundClosedPositionsReport,
  getAlgofundChartSnapshot,
  previewAdminSweepBacktest,
  listStrategyClientSystemProfilesState,
  createStrategyClientSystemProfile,
  updateStrategyClientSystemProfile,
  deleteStrategyClientSystemProfile,
  activateStrategyClientSystemProfileById,
  requestAlgofundBatchAction,
  removeAlgofundStorefrontSystem,
  getCopytradingState,
  updateCopytradingState,
  stopCopytradingBaseline,
  executeCopytradingSession,
  closeCopytradingSession,
  getCopytradingSessions,
  getCopytradingReport,
  getCopytradingStatus,
  getSynctradeState,
  updateSynctradeState,
  executeSynctradeSession,
  closeSynctradeSession,
  getSynctradeSessions,
  getSynctradeLivePnl,
  startSyncAutoEngine,
  stopSyncAutoEngine,
  getSyncAutoStatus,
  getAlgofundActiveSystems,
  assignAlgofundSystems,
  toggleAlgofundSystem,
  removeAlgofundSystemFromProfile,
  deleteTenantById,
  batchConnectStrategyClientOffer,
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

router.get('/admin/high-trade-recommendations', async (req, res) => {
  try {
    const minProfitFactor = toOptionalNumber(req.query.minProfitFactor);
    const maxDrawdownPercent = toOptionalNumber(req.query.maxDrawdownPercent);
    const minReturnPercent = toOptionalNumber(req.query.minReturnPercent);
    const limit = toOptionalNumber(req.query.limit);
    const data = await getHighTradeRecommendations({
      minProfitFactor,
      maxDrawdownPercent,
      minReturnPercent,
      limit,
    });
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS high-trade recommendations error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/curated-draft-members', async (_req, res) => {
  try {
    const members = await getCuratedDraftMembers();
    res.json({ members });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS curated draft members read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/curated-draft-members', async (req, res) => {
  try {
    const members = Array.isArray(req.body?.members) ? req.body.members : [];
    const saved = await setCuratedDraftMembers(members);
    res.json({ success: true, members: saved });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS curated draft members save error: ${err.message}`);
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
      runtimeOnly: req.body?.runtimeOnly !== undefined ? toBool(req.body.runtimeOnly) : undefined,
      reconciliationCycleEnabled: req.body?.reconciliationCycleEnabled !== undefined
        ? toBool(req.body.reconciliationCycleEnabled)
        : undefined,
      reportIntervalMinutes: req.body?.reportIntervalMinutes !== undefined
        ? toOptionalNumber(req.body.reportIntervalMinutes)
        : undefined,
      sectionAccounts: req.body?.sectionAccounts !== undefined ? toBool(req.body.sectionAccounts) : undefined,
      sectionDrift: req.body?.sectionDrift !== undefined ? toBool(req.body.sectionDrift) : undefined,
      sectionLowlot: req.body?.sectionLowlot !== undefined ? toBool(req.body.sectionLowlot) : undefined,
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
      tsBacktestSnapshotsPatch: req.body?.tsBacktestSnapshotsPatch && typeof req.body.tsBacktestSnapshotsPatch === 'object'
        ? req.body.tsBacktestSnapshotsPatch
        : undefined,
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
    const source = String(req.body?.source || '').trim().toLowerCase();
    const hasSystemName = String(req.body?.systemName || '').trim().length > 0;
    const requestedKind = String(req.body?.kind || '').trim().toLowerCase();
    const inferredKind = requestedKind === 'offer' || requestedKind === 'algofund-ts'
      ? requestedKind as 'offer' | 'algofund-ts'
      : (
        source === 'offer_store'
        || source === 'runtime_system'
        || hasSystemName
          ? 'algofund-ts'
          : 'offer'
      );
    const data = await previewAdminSweepBacktest({
      kind: inferredKind,
      setKey: req.body?.setKey ? String(req.body.setKey) : undefined,
      systemName: req.body?.systemName ? String(req.body.systemName) : undefined,
      offerId: req.body?.offerId ? String(req.body.offerId) : undefined,
      offerIds: Array.isArray(req.body?.offerIds) ? req.body.offerIds.map((item: unknown) => String(item)) : undefined,
      offerWeightsById: req.body?.offerWeightsById && typeof req.body.offerWeightsById === 'object'
        ? Object.fromEntries(
          Object.entries(req.body.offerWeightsById as Record<string, unknown>)
            .map(([key, value]) => [String(key), toOptionalNumber(value) ?? 0])
        )
        : undefined,
      riskScore: toOptionalNumber(req.body?.riskScore),
      tradeFrequencyScore: toOptionalNumber(req.body?.tradeFrequencyScore),
      initialBalance: toOptionalNumber(req.body?.initialBalance),
      riskScaleMaxPercent: toOptionalNumber(req.body?.riskScaleMaxPercent),
      dateFrom: req.body?.dateFrom ? String(req.body.dateFrom) : undefined,
      dateTo: req.body?.dateTo ? String(req.body.dateTo) : undefined,
      rerunApiKeyName: req.body?.rerunApiKeyName ? String(req.body.rerunApiKeyName) : undefined,
      preferRealBacktest: req.body?.preferRealBacktest !== undefined ? toBool(req.body.preferRealBacktest, false) : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS admin sweep backtest preview error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/storefront-system/remove', async (req, res) => {
  try {
    const systemName = req.body?.systemName ? String(req.body.systemName).trim() : '';
    const force = toBool(req.body?.force, false);
    const dryRun = toBool(req.body?.dryRun, false);
    const closePositions = toBool(req.body?.closePositions, false);
    if (!systemName) {
      return res.status(400).json({ error: 'systemName is required' });
    }
    const data = await removeAlgofundStorefrontSystem({ systemName, force, dryRun, closePositions });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS storefront-system remove error: ${err.message}`);
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

router.get('/admin/snapshots/refresh-status', async (_req, res) => {
  try {
    const [state, settings] = await Promise.all([
      getOfferStoreSnapshotRefreshState(),
      getAdminReportSettings(),
    ]);
    res.json({ success: true, state, settings });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS snapshot refresh-status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/snapshots/refresh', async (req, res) => {
  try {
    const force = toBool(req.body?.force, false);
    const reason = req.body?.reason ? String(req.body.reason) : undefined;
    const data = await refreshOfferStoreSnapshotsFromSweep({ force, reason });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS snapshot refresh error: ${err.message}`);
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

router.get('/admin/reports/ts-health', async (req, res) => {
  try {
    const tenantId = toOptionalNumber(req.query.tenantId);
    const systemName = req.query.systemName ? String(req.query.systemName) : undefined;
    const lookbackHours = toOptionalNumber(req.query.lookbackHours);
    const data = await getAlgofundSystemHealthReport({ tenantId, systemName, lookbackHours });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS ts-health report error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/reports/closed-positions', async (req, res) => {
  try {
    const tenantId = toOptionalNumber(req.query.tenantId);
    const systemName = req.query.systemName ? String(req.query.systemName) : undefined;
    const periodHours = toOptionalNumber(req.query.periodHours);
    const limit = toOptionalNumber(req.query.limit);
    const data = await getAlgofundClosedPositionsReport({ tenantId, systemName, periodHours, limit });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS closed-positions report error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/reports/chart-snapshot', async (req, res) => {
  try {
    const tenantId = toOptionalNumber(req.body?.tenantId);
    const strategyId = toOptionalNumber(req.body?.strategyId);
    const candles = toOptionalNumber(req.body?.candles);
    const width = toOptionalNumber(req.body?.width);
    const height = toOptionalNumber(req.body?.height);
    const interval = req.body?.interval ? String(req.body.interval) : undefined;
    const systemName = req.body?.systemName ? String(req.body.systemName) : undefined;
    const data = await getAlgofundChartSnapshot({
      tenantId,
      systemName,
      strategyId,
      candles,
      width,
      height,
      interval,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS chart-snapshot report error: ${err.message}`);
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
      applyToSystem: toBool(req.body?.applyToSystem, false),
      systemId: toOptionalNumber(req.body?.systemId),
      replacementSymbol: req.body?.replacementSymbol ? String(req.body.replacementSymbol).trim() : undefined,
    });
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS apply-low-lot-recommendation error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/reports/send-telegram', async (req, res) => {
  try {
    const controls = await getAdminTelegramControls();
    const formatRaw = String(req.body?.format || '').trim().toLowerCase();
    const format = formatRaw === 'short' ? 'short' : 'full';
    await runAdminTelegramReportNow({ periodHours: 24, runtimeOnly: controls.runtimeOnly, format });
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS send telegram report error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/publish', async (req, res) => {
  try {
    const data = await publishAdminTradingSystem({
      offerIds: Array.isArray(req.body?.offerIds) ? req.body.offerIds.map((item: unknown) => String(item || '')) : undefined,
      setKey: req.body?.setKey ? String(req.body.setKey || '') : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS publish admin TS error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/tenants', async (req, res) => {
  const {
    displayName,
    productMode,
    planCode,
    algofundPlanCode,
    assignedApiKeyName,
    inlineApiKeyName,
    inlineApiKey,
    inlineApiSecret,
    inlineApiExchange,
    inlineApiPassphrase,
    inlineApiSpeedLimit,
    inlineApiTestnet,
    inlineApiDemo,
    language,
    email,
    fullName,
  } = req.body;
  if (!displayName || !productMode || !planCode) {
    return res.status(400).json({ error: 'displayName, productMode, and planCode are required' });
  }
  try {
    const tenants = await createTenantByAdmin({
      displayName: String(displayName),
      productMode,
      planCode: String(planCode),
      algofundPlanCode: algofundPlanCode ? String(algofundPlanCode) : undefined,
      assignedApiKeyName: assignedApiKeyName ? String(assignedApiKeyName) : undefined,
      inlineApiKeyName: inlineApiKeyName ? String(inlineApiKeyName) : undefined,
      inlineApiKey: inlineApiKey ? String(inlineApiKey) : undefined,
      inlineApiSecret: inlineApiSecret ? String(inlineApiSecret) : undefined,
      inlineApiExchange: inlineApiExchange ? String(inlineApiExchange) : undefined,
      inlineApiPassphrase: inlineApiPassphrase ? String(inlineApiPassphrase) : undefined,
      inlineApiSpeedLimit: toOptionalNumber(inlineApiSpeedLimit),
      inlineApiTestnet: inlineApiTestnet !== undefined ? toBool(inlineApiTestnet) : undefined,
      inlineApiDemo: inlineApiDemo !== undefined ? toBool(inlineApiDemo) : undefined,
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

router.post('/admin/strategy-client-batch-connect', async (req, res) => {
  try {
    const offerIds = Array.isArray(req.body?.offerIds) ? req.body.offerIds.map((item: unknown) => String(item)) : [];
    const tenantIds = Array.isArray(req.body?.tenantIds) ? req.body.tenantIds.map((item: unknown) => Number(item)).filter((v: number) => Number.isFinite(v) && v > 0) : [];
    if (offerIds.length === 0) return res.status(400).json({ error: 'offerIds required' });
    if (tenantIds.length === 0) return res.status(400).json({ error: 'tenantIds required' });
    const data = await batchConnectStrategyClientOffer(offerIds, tenantIds);
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS strategy-client batch connect error: ${err.message}`);
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

router.get('/copytrading/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await getCopytradingState(tenantId);
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading state error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/copytrading/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }

  try {
    const data = await updateCopytradingState(tenantId, {
      masterApiKeyName: req.body.masterApiKeyName,
      masterName: req.body.masterName,
      masterTags: req.body.masterTags,
      tenants: Array.isArray(req.body.tenants) ? req.body.tenants : undefined,
      copyAlgorithm: req.body.copyAlgorithm,
      copyPrecision: req.body.copyPrecision,
      copyRatio: toOptionalNumber(req.body.copyRatio),
      copyEnabled: req.body.copyEnabled !== undefined ? toBool(req.body.copyEnabled) : undefined,
    });
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading update error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/copytrading/:tenantId/execute', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const result = await executeCopytradingSession(tenantId, {
      symbol: req.body.symbol,
      marketType: req.body.marketType === 'spot' ? 'spot' : 'swap',
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading execute error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/copytrading/:tenantId/stop', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const data = await stopCopytradingBaseline(tenantId);
    res.json({ success: true, ...data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading stop error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/copytrading/:tenantId/close/:sessionId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const sessionId = Number(req.params.sessionId);
  if (!Number.isFinite(tenantId) || !Number.isFinite(sessionId)) {
    return res.status(400).json({ error: 'Invalid tenantId or sessionId' });
  }
  try {
    const result = await closeCopytradingSession(tenantId, sessionId);
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading close error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/copytrading/:tenantId/sessions', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const sessions = await getCopytradingSessions(tenantId);
    res.json({ success: true, sessions });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading sessions error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/copytrading/:tenantId/status', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const status = await getCopytradingStatus(tenantId);
    res.json({ success: true, ...status });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/copytrading/:tenantId/report', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const report = await getCopytradingReport(tenantId);
    res.json({ success: true, report });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS copytrading report error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Multi-TS Algofund endpoints ──────────────────────────────────────────────

router.get('/algofund/:tenantId/active-systems', async (req, res) => {
  const profileId = Number(req.params.tenantId);
  if (!Number.isFinite(profileId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const data = await getAlgofundActiveSystems(profileId);
    res.json({ success: true, systems: data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund active-systems read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/algofund/:tenantId/active-systems', async (req, res) => {
  const profileId = Number(req.params.tenantId);
  if (!Number.isFinite(profileId)) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  if (!Array.isArray(req.body?.systems)) {
    return res.status(400).json({ error: 'systems array is required' });
  }
  try {
    const systems = req.body.systems.map((s: Record<string, unknown>) => ({
      systemName: String(s.systemName || ''),
      weight: s.weight !== undefined ? Number(s.weight) : 1,
      isEnabled: s.isEnabled !== false,
      assignedBy: s.assignedBy === 'client' ? 'client' : ('admin' as const),
    }));
    const data = await assignAlgofundSystems({
      profileId,
      systems,
      replace: Boolean(req.body?.replace),
    });
    res.json({ success: true, systems: data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund assign-systems error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/algofund/:tenantId/active-systems/:systemName/toggle', async (req, res) => {
  const profileId = Number(req.params.tenantId);
  const systemName = decodeURIComponent(String(req.params.systemName || '').trim());
  if (!Number.isFinite(profileId) || !systemName) {
    return res.status(400).json({ error: 'Invalid tenantId or systemName' });
  }
  const isEnabled = toBool(req.body?.isEnabled, true);
  const apiKeyName = String(req.body?.apiKeyName || '').trim();
  if (!apiKeyName) {
    return res.status(400).json({ error: 'apiKeyName is required for pair conflict check' });
  }
  const actorMode = req.body?.actorMode === 'client' ? 'client' : ('admin' as const);
  try {
    const data = await toggleAlgofundSystem({ profileId, systemName, isEnabled, apiKeyName, actorMode });
    if (data.conflicts.length > 0) {
      return res.status(409).json({
        success: false,
        error: 'Pair conflict detected',
        conflicts: data.conflicts,
        activeSystems: data.activeSystems,
      });
    }
    res.json({ success: true, systems: data.activeSystems });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund toggle-system error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/algofund/:tenantId/active-systems/:systemName', async (req, res) => {
  const profileId = Number(req.params.tenantId);
  const systemName = decodeURIComponent(String(req.params.systemName || '').trim());
  if (!Number.isFinite(profileId) || !systemName) {
    return res.status(400).json({ error: 'Invalid tenantId or systemName' });
  }
  try {
    const data = await removeAlgofundSystemFromProfile({ profileId, systemName });
    res.json({ success: true, systems: data });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS algofund remove-system error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/admin/tenants/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    await deleteTenantById(tenantId);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS delete tenant error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── Synctrade routes ────────────────────────────────────────────────────────

router.get('/synctrade/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const state = await getSynctradeState(tenantId);
    res.json(state);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade GET error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.patch('/synctrade/:tenantId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const state = await updateSynctradeState(tenantId, req.body || {});
    res.json(state);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade PATCH error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/synctrade/:tenantId/execute', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const result = await executeSynctradeSession(tenantId, req.body || {});
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade execute error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/synctrade/:tenantId/close/:sessionId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const sessionId = Number(req.params.sessionId);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId or sessionId' });
  }
  try {
    const result = await closeSynctradeSession(tenantId, sessionId);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade close error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/synctrade/:tenantId/sessions', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const sessions = await getSynctradeSessions(tenantId);
    res.json({ sessions });
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade sessions error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/synctrade/:tenantId/live-pnl/:sessionId', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  const sessionId = Number(req.params.sessionId);
  if (!Number.isFinite(tenantId) || tenantId <= 0 || !Number.isFinite(sessionId) || sessionId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId or sessionId' });
  }
  try {
    const result = await getSynctradeLivePnl(tenantId, sessionId);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`SaaS synctrade live-pnl error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ─── SyncAuto engine routes ──────────────────────────────────────────────────

router.post('/synctrade/:tenantId/auto/start', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const result = await startSyncAutoEngine(tenantId, req.body || {});
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`SyncAuto start error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/synctrade/:tenantId/auto/stop', async (req, res) => {
  const tenantId = Number(req.params.tenantId);
  if (!Number.isFinite(tenantId) || tenantId <= 0) {
    return res.status(400).json({ error: 'Invalid tenantId' });
  }
  try {
    const closeAll = Boolean(req.body?.closeAll);
    const result = await stopSyncAutoEngine(closeAll);
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`SyncAuto stop error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/synctrade/auto/status', async (_req, res) => {
  try {
    const status = getSyncAutoStatus();
    res.json(status);
  } catch (error) {
    const err = error as Error;
    logger.error(`SyncAuto status error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

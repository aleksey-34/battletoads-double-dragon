import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  getMarketData,
  placeOrder,
  getOrderStatus,
  getBalances,
  getPositions,
  closePosition,
  closePositionPercent as closePositionPercentExchange,
  initExchangeClient,
  get24hVolume,
  getInstrumentInfo,
  getAllSymbols,
  removeExchangeClient,
  getOpenOrders,
  getRecentTrades,
  cancelAllOrders,
  closeAllPositions,
} from '../bot/exchange';
import { calculateSyntheticOHLC } from '../bot/synthetic';
import { getRiskSettings, updateRiskSettings } from '../bot/risk';
import {
  getStrategies,
  getStrategySummaries,
  getStrategyById,
  createStrategy,
  updateStrategy,
  deleteStrategy,
  executeStrategy,
  pauseStrategy,
  stopStrategy,
  closePositionPercent,
  placeManualOrder,
  cancelStrategyOrders,
  closeStrategyPositions,
  setAllStrategiesActive,
  copyStrategyBlock,
} from '../bot/strategy';
import {
  createTradingSystem,
  deleteTradingSystem,
  getTradingSystem,
  listTradingSystems,
  replaceTradingSystemMembers,
  replaceTradingSystemMembersSafely,
  runTradingSystemBacktest,
  setTradingSystemActivation,
  updateTradingSystem,
} from '../bot/tradingSystems';
import { getMonitoringLatest, getMonitoringSnapshots, recordMonitoringSnapshot } from '../bot/monitoring';
import { deleteBacktestRun, getBacktestRun, listBacktestRuns, runBacktest, saveBacktestRun } from '../backtest/engine';
import { loadSettings, saveApiKey, saveRiskSettings, ApiKey, RiskSettings, Strategy } from '../config/settings';
import { db } from '../utils/database';
import {
  authenticate,
  authenticateClient,
  completeClientOnboarding,
  getClientAuthPayloadFromSession,
  loginClientByMagicToken,
  loginClientUser,
  requirePlatformAdmin,
  registerClientUser,
  revokeClientSession,
} from '../utils/auth';
import { notifyAdminNewUser } from '../notifications/adminTelegramReporter';
import logger from '../utils/logger';
import { initResearchDb } from '../research/db';
import { getPreset, listOfferIds } from '../research/presetBuilder';
import { getGitUpdateJobStatus, getGitUpdateStatus, triggerGitUpdate } from '../system/updateManager';
import {
  getPasswordRecoveryStatus,
  PasswordRecoveryError,
  requestPasswordRecoveryCode,
  resetPasswordWithRecoveryCode,
} from '../system/passwordRecovery';
import {
  getAlgofundState,
  getStrategyClientState,
  previewStrategyClientOffer,
  previewStrategyClientSelection,
  requestAlgofundAction,
  updateAlgofundState,
  updateStrategyClientState,
  loadCatalogAndSweepWithFallback,
} from '../saas/service';
import analyticsRoutes from './analyticsRoutes';
import saasRoutes from './saasRoutes';
import fs from 'fs';
import path from 'path';

const router = Router();
let backtestRunInProgress = false;

const STRATEGY_PATCH_ALLOWED_FIELDS = new Set<string>([
  'id',
  'name',
  'is_active',
  'display_on_chart',
  'show_settings',
  'show_chart',
  'show_indicators',
  'show_positions_on_chart',
  'show_trades_on_chart',
  'show_values_each_bar',
  'auto_update',
  'strategy_type',
  'market_mode',
  'take_profit_percent',
  'price_channel_length',
  'detection_source',
  'zscore_entry',
  'zscore_exit',
  'zscore_stop',
  'base_symbol',
  'quote_symbol',
  'interval',
  'base_coef',
  'quote_coef',
  'long_enabled',
  'short_enabled',
  'lot_long_percent',
  'lot_short_percent',
  'max_deposit',
  'margin_type',
  'leverage',
  'fixed_lot',
  'reinvest_percent',
  'state',
  'entry_ratio',
  'last_signal',
  'last_action',
  'last_error',
]);

const CLIENT_GUIDES_ROOT_DIR = path.resolve(__dirname, '../../..', 'docs', 'exchange-guides');
const REPO_ROOT_DIR = path.resolve(__dirname, '../../..');
const ADMIN_DOCS_EXCLUDED_DIR_NAMES = new Set([
  '.git',
  '.github',
  'node_modules',
  'build',
  'dist',
  'coverage',
  'test-results',
]);
const ADMIN_DOCS_EXCLUDED_RELATIVE_PREFIXES = [
  'logs',
  'results',
  'backend/logs',
  'frontend/build',
  'frontend/test-results',
];

const CLIENT_EXCHANGE_GUIDES: Record<string, { id: string; title: string; fileName: string }> = {
  bybit: {
    id: 'bybit',
    title: 'Bybit API Key Quick Guide',
    fileName: 'bybit-api-key-quick-guide.md',
  },
  binance: {
    id: 'binance',
    title: 'Binance API Key Quick Guide',
    fileName: 'binance-api-key-quick-guide.md',
  },
  bingx: {
    id: 'bingx',
    title: 'BingX API Key Quick Guide',
    fileName: 'bingx-api-key-quick-guide.md',
  },
  bitget: {
    id: 'bitget',
    title: 'Bitget API Key Quick Guide',
    fileName: 'bitget-api-key-quick-guide.md',
  },
  weex: {
    id: 'weex',
    title: 'WEEX API Key Quick Guide',
    fileName: 'weex-api-key-quick-guide.md',
  },
  mexc: {
    id: 'mexc',
    title: 'MEXC API Key Quick Guide',
    fileName: 'mexc-api-key-quick-guide.md',
  },
};

const exchangeRequiresPassphrase = (exchange: string): boolean => {
  const normalized = String(exchange || '').trim().toLowerCase();
  return normalized.includes('bitget') || normalized.includes('weex');
};

type AdminMarkdownDocRecord = {
  relativePath: string;
  title: string;
  group: string;
  sizeBytes: number;
  updatedAt: string | null;
  content: string;
};

const normalizeDocRelativePath = (filePath: string): string => path.relative(REPO_ROOT_DIR, filePath).split(path.sep).join('/');

const shouldSkipAdminDocsDirectory = (relativeDir: string, entryName: string): boolean => {
  const normalizedName = String(entryName || '').trim().toLowerCase();
  if (ADMIN_DOCS_EXCLUDED_DIR_NAMES.has(normalizedName)) {
    return true;
  }

  const nextRelativeDir = [relativeDir, entryName].filter(Boolean).join('/');
  return ADMIN_DOCS_EXCLUDED_RELATIVE_PREFIXES.some((prefix) => nextRelativeDir === prefix || nextRelativeDir.startsWith(`${prefix}/`));
};

const extractMarkdownTitle = (content: string, relativePath: string): string => {
  const headingLine = content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /^#\s+/.test(line));

  if (headingLine) {
    return headingLine.replace(/^#\s+/, '').trim();
  }

  const fileName = path.basename(relativePath, path.extname(relativePath));
  return fileName.replace(/[-_]+/g, ' ').trim() || relativePath;
};

const collectAdminMarkdownDocs = (): AdminMarkdownDocRecord[] => {
  const docs: AdminMarkdownDocRecord[] = [];

  const walk = (absoluteDir: string, relativeDir: string) => {
    if (!fs.existsSync(absoluteDir)) {
      return;
    }

    const entries = fs.readdirSync(absoluteDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }

      const absolutePath = path.join(absoluteDir, entry.name);
      const relativePath = [relativeDir, entry.name].filter(Boolean).join('/');

      if (entry.isDirectory()) {
        if (shouldSkipAdminDocsDirectory(relativeDir, entry.name)) {
          continue;
        }
        walk(absolutePath, relativePath);
        continue;
      }

      if (!entry.isFile() || !entry.name.toLowerCase().endsWith('.md')) {
        continue;
      }

      const content = fs.readFileSync(absolutePath, 'utf-8');
      const stat = fs.statSync(absolutePath);
      const normalizedRelativePath = normalizeDocRelativePath(absolutePath);
      docs.push({
        relativePath: normalizedRelativePath,
        title: extractMarkdownTitle(content, normalizedRelativePath),
        group: normalizedRelativePath.includes('/') ? normalizedRelativePath.split('/')[0] : 'root',
        sizeBytes: stat.size,
        updatedAt: stat.mtime ? stat.mtime.toISOString() : null,
        content,
      });
    }
  };

  walk(REPO_ROOT_DIR, '');

  return docs.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
};

const toOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

const toOptionalBool = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
};

const isLevel3 = (value: unknown): value is 'low' | 'medium' | 'high' => {
  return value === 'low' || value === 'medium' || value === 'high';
};

const resolveClientAuthErrorStatus = (message: string): number => {
  const normalized = String(message || '').toLowerCase();

  if (normalized.includes('invalid email or password')) {
    return 401;
  }

  if (normalized.includes('disabled') || normalized.includes('not active')) {
    return 403;
  }

  if (normalized.includes('valid email') || normalized.includes('already exists') || normalized.includes('password')) {
    return 400;
  }

  return 500;
};

// Public auth-recovery routes (no password required)
router.get('/auth/recovery/status', (_req, res) => {
  try {
    const status = getPasswordRecoveryStatus();
    res.json(status);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error reading recovery status: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/auth/recovery/request', async (req, res) => {
  try {
    const result = await requestPasswordRecoveryCode({
      ip: String(req.ip || ''),
      userAgent: String(req.headers['user-agent'] || ''),
    });
    res.json({ success: true, ...result });
  } catch (error: any) {
    const err = error as Error;
    const statusCode = error instanceof PasswordRecoveryError ? error.statusCode : 500;
    logger.error(`Error requesting password recovery code: ${err.message}`);
    res.status(statusCode).json({ error: err.message });
  }
});

router.post('/auth/recovery/reset', async (req, res) => {
  const code = String(req.body?.code || '');
  const newPassword = String(req.body?.newPassword || '');

  try {
    const result = await resetPasswordWithRecoveryCode(code, newPassword);
    res.json({ success: true, ...result });
  } catch (error: any) {
    const err = error as Error;
    const statusCode = error instanceof PasswordRecoveryError ? error.statusCode : 500;
    logger.error(`Error resetting password via recovery flow: ${err.message}`);
    res.status(statusCode).json({ error: err.message });
  }
});

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
      },
      {
        ip: String(req.ip || ''),
        userAgent: String(req.headers['user-agent'] || ''),
      }
    );

    res.json({ success: true, ...result });

    // Async notification — don't block response
    notifyAdminNewUser({
      email: String(req.body?.email || ''),
      displayName: String(req.body?.fullName || req.body?.companyName || ''),
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
  }));

  res.json({ success: true, guides });
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

    const [strategyResult, algofundResult] = await Promise.allSettled([
      getStrategyClientState(tenantId),
      getAlgofundState(tenantId, toOptionalNumber(req.query.riskMultiplier), false),
    ]);

    if (strategyResult.status === 'rejected') {
      logger.warn(`Client workspace strategy state unavailable for tenant ${tenantId}: ${strategyResult.reason instanceof Error ? strategyResult.reason.message : String(strategyResult.reason)}`);
    }
    if (algofundResult.status === 'rejected') {
      logger.warn(`Client workspace algofund state unavailable for tenant ${tenantId}: ${algofundResult.reason instanceof Error ? algofundResult.reason.message : String(algofundResult.reason)}`);
    }

    return res.json({
      success: true,
      auth: getClientAuthPayloadFromSession(session),
      productMode,
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
    res.status(500).json({ error: err.message });
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
    res.status(500).json({ error: err.message });
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

    const state = await requestAlgofundAction(
      Number(session.user.tenantId),
      requestType,
      String(req.body?.note || ''),
      {
        targetSystemId: toOptionalNumber(req.body?.targetSystemId),
        targetSystemName: req.body?.targetSystemName ? String(req.body.targetSystemName) : undefined,
      }
    );

    res.json({ success: true, state });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client algofund action request error: ${err.message}`);
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

    const [strategyResult, algofundResult] = await Promise.allSettled([
      updateStrategyClientState(tenantId, { assignedApiKeyName: keyName }),
      updateAlgofundState(tenantId, { assignedApiKeyName: keyName }),
    ]);

    if (strategyResult.status === 'rejected') {
      logger.warn(`Client api key save: strategy profile update unavailable for tenant ${tenantId}: ${strategyResult.reason instanceof Error ? strategyResult.reason.message : String(strategyResult.reason)}`);
    }
    if (algofundResult.status === 'rejected') {
      logger.warn(`Client api key save: algofund profile update unavailable for tenant ${tenantId}: ${algofundResult.reason instanceof Error ? algofundResult.reason.message : String(algofundResult.reason)}`);
    }

    return res.json({
      success: true,
      keyName,
      productMode: session.user.productMode,
      strategyState: strategyResult.status === 'fulfilled' ? strategyResult.value : null,
      algofundState: algofundResult.status === 'fulfilled' ? algofundResult.value : null,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key save error: ${err.message}`);
    res.status(500).json({ error: err.message });
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

    const tenant = await db.get(
      'SELECT assigned_api_key_name FROM tenants WHERE id = ?',
      [tenantId]
    ) as { assigned_api_key_name?: string } | undefined;
    const strategyProfile = await db.get(
      'SELECT assigned_api_key_name FROM strategy_client_profiles WHERE tenant_id = ?',
      [tenantId]
    ) as { assigned_api_key_name?: string } | undefined;
    const algofundProfile = await db.get(
      'SELECT assigned_api_key_name, execution_api_key_name FROM algofund_profiles WHERE tenant_id = ?',
      [tenantId]
    ) as { assigned_api_key_name?: string; execution_api_key_name?: string } | undefined;
    const assignedName = String(tenant?.assigned_api_key_name || '').trim();
    const strategyAssignedName = String(strategyProfile?.assigned_api_key_name || '').trim();
    const algofundAssignedName = String(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name || '').trim();

    res.json({
      success: true,
      assignedApiKeyName: assignedName,
      strategyAssignedApiKeyName: strategyAssignedName,
      algofundAssignedApiKeyName: algofundAssignedName,
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

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_api_key_update', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify({ apiKeyId, keyName, exchange, testnet, demo })]
    );

    res.json({ success: true, id: apiKeyId, name: keyName });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key update error: ${err.message}`);
    res.status(500).json({ error: err.message });
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

    const tenant = await db.get('SELECT assigned_api_key_name FROM tenants WHERE id = ?', [tenantId]) as { assigned_api_key_name?: string } | undefined;
    if (String(tenant?.assigned_api_key_name || '').trim() === keyName) {
      return res.status(409).json({ error: 'Cannot delete currently assigned API key. Assign another key first.' });
    }

    await db.run('DELETE FROM risk_settings WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM strategies WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM monitoring_snapshots WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM api_keys WHERE id = ?', [apiKeyId]);
    removeExchangeClient(keyName);

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_api_key_delete', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify({ apiKeyId, keyName })]
    );

    res.json({ success: true, id: apiKeyId, name: keyName });
  } catch (error) {
    const err = error as Error;
    logger.error(`Client api key delete error: ${err.message}`);
    res.status(500).json({ error: err.message });
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

    const payload = {
      targetPlanCode: targetPlan.code,
      targetPlanTitle: String(targetPlan.title || targetPlan.code),
      note,
    };

    const insert = await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (?, 'client', 'client_tariff_request', ?, CURRENT_TIMESTAMP)`,
      [tenantId, JSON.stringify(payload)]
    );

    res.json({
      success: true,
      request: {
        id: Number((insert as any)?.lastID || 0),
        ...payload,
      },
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
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;

    const requestedMode = String(req.query.mode || '').trim().toLowerCase();
    const [tenant, strategyProfile, algofundProfile] = await Promise.all([
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
    ]);

    const tenantApiKeyName = String(tenant?.assigned_api_key_name || '').trim();
    const strategyApiKeyName = String(strategyProfile?.assigned_api_key_name || '').trim();
    const algofundApiKeyName = String(algofundProfile?.execution_api_key_name || algofundProfile?.assigned_api_key_name || '').trim();

    const resolveApiKeyName = () => {
      if (requestedMode === 'algofund') {
        return algofundApiKeyName || strategyApiKeyName || tenantApiKeyName;
      }
      if (requestedMode === 'strategy') {
        return strategyApiKeyName || algofundApiKeyName || tenantApiKeyName;
      }
      return strategyApiKeyName || algofundApiKeyName || tenantApiKeyName;
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

    const loadStream = async (targetApiKeyName: string) => {
      const safeName = String(targetApiKeyName || '').trim();
      if (!safeName) {
        return { apiKeyName: '', latest: null, points: [] as any[] };
      }
      const points = await getMonitoringSnapshots(safeName, limit, days);
      const latest = points.length > 0 ? points[points.length - 1] : await getMonitoringLatest(safeName);
      return {
        apiKeyName: safeName,
        latest: latest || null,
        points: points || [],
      };
    };

    const [selectedStream, strategyStream, algofundStream] = await Promise.all([
      loadStream(apiKeyName),
      loadStream(strategyApiKeyName),
      loadStream(algofundApiKeyName),
    ]);

    res.json({
      success: true,
      apiKeyName: selectedStream.apiKeyName,
      latest: selectedStream.latest,
      points: selectedStream.points,
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

// SaaS admin routes need to be BEFORE requirePlatformAdmin so they're accessible from the internal frontend dashboard
router.use('/saas', saasRoutes);

// Analytics routes for live reconciliation and drift analysis
router.use('/analytics', analyticsRoutes);

// Public routes for Backtest page (require Bearer token from frontend, but NOT the requirePlatformAdmin guard)
// These endpoints are used by the dashboard's internal Backtest page
router.get('/api-keys', async (req, res) => {
  try {
    const { apiKeys } = await loadSettings();
    // Enrich with tenant info for Dashboard labels
    const tenantMapping = await db.all(
      `SELECT t.display_name, t.product_mode, COALESCE(t.assigned_api_key_name, '') AS api_key_name
       FROM tenants t WHERE t.status != 'deleted'`
    ).catch(() => []) as Array<{ display_name: string; product_mode: string; api_key_name: string }>;
    const tenantByApiKey = new Map<string, { displayName: string; productMode: string }>();
    for (const row of tenantMapping) {
      const key = String(row.api_key_name || '').trim();
      if (key) tenantByApiKey.set(key, { displayName: row.display_name, productMode: row.product_mode });
    }
    const enriched = apiKeys.map((k: any) => {
      const tenant = tenantByApiKey.get(String(k.name || ''));
      return tenant ? { ...k, tenantDisplayName: tenant.displayName, tenantProductMode: tenant.productMode } : k;
    });
    res.json(enriched);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading API keys: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const strategies = await getStrategies(apiKeyName);
    res.json(strategies);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest strategies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/backtest/run', async (req, res) => {
  if (backtestRunInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestRunInProgress = true;
    const saveResult = req.body?.saveResult !== false;
    const result = await runBacktest(req.body || {});
    let runId: number | null = null;

    if (saveResult) {
      runId = await saveBacktestRun(result);
      result.runId = runId;
    }

    res.json({ success: true, runId, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running backtest: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    backtestRunInProgress = false;
  }
});

router.get('/backtest/runs', async (req, res) => {
  const apiKeyName = req.query.apiKeyName ? String(req.query.apiKeyName) : undefined;
  const limitRaw = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;

  try {
    const rows = await listBacktestRuns(limit, apiKeyName);
    res.json(rows);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest runs: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const run = await getBacktestRun(id);
    if (!run) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json(run);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/backtest/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const deleted = await deleteBacktestRun(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Применить platform-admin guard ко всем admin маршрутам
router.use(requirePlatformAdmin);

router.get('/admin/docs', async (_req, res) => {
  try {
    const docs = collectAdminMarkdownDocs().map(({ content, ...doc }) => doc);
    res.json({ success: true, docs });
  } catch (error) {
    const err = error as Error;
    logger.error(`Admin docs list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/admin/docs/content', async (req, res) => {
  const docPath = String(req.query.docPath || '').trim();
  if (!docPath) {
    return res.status(400).json({ error: 'docPath is required' });
  }

  try {
    const doc = collectAdminMarkdownDocs().find((item) => item.relativePath === docPath);
    if (!doc) {
      return res.status(404).json({ error: 'Document not found' });
    }

    res.json({ success: true, doc });
  } catch (error) {
    const err = error as Error;
    logger.error(`Admin docs read error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Получить последние строки логов
router.get('/logs', async (req, res) => {
  const combinedLogPath = path.join(__dirname, '../../logs/combined.log');
  const errorLogPath = path.join(__dirname, '../../logs/error.log');

  const readTailLines = (targetPath: string, maxLines: number): string[] => {
    if (!fs.existsSync(targetPath)) {
      return [];
    }
    const lines = fs.readFileSync(targetPath, 'utf-8').split('\n').filter((line) => String(line || '').trim());
    return lines.slice(-Math.max(1, maxLines));
  };

  try {
    const combinedTail = readTailLines(combinedLogPath, 140);
    const errorTail = readTailLines(errorLogPath, 160);
    const merged = [...combinedTail, ...errorTail].slice(-220);
    res.json(merged);
  } catch (error) {
    res.status(500).json({ error: 'Log read error' });
  }
});

// Системные Git-обновления (VPS)
router.get('/system/update/status', async (req, res) => {
  const refresh = String(req.query.refresh || '1') !== '0';

  try {
    const status = await getGitUpdateStatus(refresh);
    res.json(status);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error reading git update status: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/system/update/run', async (req, res) => {
  try {
    const result = await triggerGitUpdate();
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error starting git update: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/system/update/job', async (req, res) => {
  try {
    const job = await getGitUpdateJobStatus();
    res.json(job);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error reading git update job: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// API ключи
router.post('/api-keys', async (req, res) => {
  const key: ApiKey = req.body;
  try {
    if (!String(key?.name || '').trim() || !String(key?.exchange || '').trim()) {
      return res.status(400).json({ error: 'name and exchange are required' });
    }
    if (!String(key?.api_key || '').trim() || !String(key?.secret || '').trim()) {
      return res.status(400).json({ error: 'api_key and secret are required' });
    }
    if (exchangeRequiresPassphrase(String(key?.exchange || '')) && !String(key?.passphrase || '').trim()) {
      return res.status(400).json({ error: 'passphrase is required for this exchange' });
    }

    await saveApiKey(key);
    // Инициализировать клиент
    const { apiKeys } = await loadSettings();
    const savedKey = apiKeys.find(k => k.name === key.name);
    if (savedKey) initExchangeClient(savedKey);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error saving API key: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  const key: ApiKey = req.body;
  try {
    if (!String(key?.name || '').trim() || !String(key?.exchange || '').trim()) {
      return res.status(400).json({ error: 'name and exchange are required' });
    }
    if (!String(key?.api_key || '').trim() || !String(key?.secret || '').trim()) {
      return res.status(400).json({ error: 'api_key and secret are required' });
    }
    if (exchangeRequiresPassphrase(String(key?.exchange || '')) && !String(key?.passphrase || '').trim()) {
      return res.status(400).json({ error: 'passphrase is required for this exchange' });
    }

    await db.run(
      'UPDATE api_keys SET name = ?, exchange = ?, api_key = ?, secret = ?, passphrase = ?, speed_limit = ?, testnet = ?, demo = ? WHERE id = ?',
      [
        key.name,
        key.exchange,
        key.api_key,
        key.secret,
        key.passphrase || '',
        key.speed_limit || 10,
        key.testnet ? 1 : 0,
        key.demo ? 1 : 0,
        id,
      ]
    );
    // Re-init client if needed
    const { apiKeys } = await loadSettings();
    const updatedKey = apiKeys.find(k => k.id === parseInt(id));
    if (updatedKey) initExchangeClient(updatedKey);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating API key: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/api-keys/:id', async (req, res) => {
  const { id } = req.params;
  const apiKeyId = Number.parseInt(id, 10);

  if (Number.isNaN(apiKeyId)) {
    return res.status(400).json({ error: 'Invalid API key id' });
  }

  try {
    const existingKey = await db.get('SELECT * FROM api_keys WHERE id = ?', [apiKeyId]);
    if (!existingKey) {
      return res.status(404).json({ error: 'API key not found' });
    }

    await db.run('DELETE FROM risk_settings WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM strategies WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM monitoring_snapshots WHERE api_key_id = ?', [apiKeyId]);
    await db.run('DELETE FROM api_keys WHERE id = ?', [apiKeyId]);

    removeExchangeClient(existingKey.name);

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting API key ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Проверка статуса API-ключа (валидность, ошибки)
router.get('/key-status/:key', async (req, res) => {
  const { key } = req.params;
  try {
    await getBalances(key);
    res.json({ status: 'ok' });
  } catch (error) {
    const err = error as Error;
    if (err.message && err.message.match(/invalid|forbidden|apikey|permission|denied/i)) {
      res.json({ status: 'critical', message: err.message });
    } else {
      res.json({ status: 'warning', message: err.message });
    }
  }
});

// Проверка статуса чарта (volume, max lot)
router.get('/chart-status/:apiKeyName/:symbol', authenticate, async (req, res) => {
  const { apiKeyName, symbol } = req.params;
  const { minVolume, lotSize } = req.query;
  try {
    const volume = await get24hVolume(apiKeyName, symbol);
    const info = await getInstrumentInfo(apiKeyName, symbol);
    const maxLot = info?.lotSizeFilter?.maxOrderQty;
    const status: any = { volumeOk: true, lotOk: true };
    if (minVolume && Number(volume) < Number(minVolume)) {
      status.volumeOk = false;
    }
    if (lotSize && maxLot && Number(lotSize) > Number(maxLot)) {
      status.lotOk = false;
    }
    res.json(status);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для риск-настроек
router.get('/risk-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const settings = await getRiskSettings(apiKeyName);
    res.json(settings);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading risk settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/risk-settings/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const settings: RiskSettings = req.body;
  try {
    await updateRiskSettings(apiKeyName, settings);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating risk settings: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для стратегий
router.post('/strategies/copy-block', async (req, res) => {
  const {
    sourceApiKey,
    targetApiKey,
    replaceTarget,
    preserveActive,
    syncSymbols,
  } = req.body || {};

  if (!sourceApiKey || !targetApiKey) {
    return res.status(400).json({ error: 'sourceApiKey and targetApiKey are required' });
  }

  try {
    const result = await copyStrategyBlock(String(sourceApiKey), String(targetApiKey), {
      replaceTarget: replaceTarget !== false,
      preserveActive: preserveActive === true,
      syncSymbols: syncSymbols !== false,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error copying strategy block: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const includeLotPreview = String(req.query.includeLotPreview || '1').trim() !== '0';
    const limitRaw = Number.parseInt(String(req.query.limit || ''), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset || '0'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;

    const strategies = await getStrategies(apiKeyName, {
      includeLotPreview,
      limit,
      offset,
    });

    if (limit !== undefined) {
      const totalRow = await db.get(
        `SELECT COUNT(*) AS total
         FROM strategies s
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE a.name = ?`,
        [apiKeyName]
      );
      const total = Number(totalRow?.total || 0);
      res.setHeader('X-Total-Count', String(total));
      res.setHeader('X-Limit-Applied', String(limit));
      res.setHeader('X-Offset-Applied', String(offset));
    }

    res.json(strategies);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategies/:apiKeyName/summary', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const limitRaw = Number.parseInt(String(req.query.limit || ''), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset || '0'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 5000) : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const includeArchived = String(req.query.includeArchived || '0').trim() !== '0';
    const runtimeOnly = String(req.query.runtimeOnly || '0').trim() !== '0';

    const summaries = await getStrategySummaries(apiKeyName, {
      limit,
      offset,
      includeArchived,
      runtimeOnly,
    });

    if (limit !== undefined) {
      const countParams: any[] = [apiKeyName];
      let countWhere = `WHERE a.name = ?`;
      if (!includeArchived) {
        countWhere += ` AND COALESCE(s.is_archived, 0) = 0`;
      }
      if (runtimeOnly) {
        countWhere += ` AND COALESCE(s.is_runtime, 0) = 1`;
      }
      const totalRow = await db.get(
        `SELECT COUNT(*) AS total
         FROM strategies s
         JOIN api_keys a ON a.id = s.api_key_id
         ${countWhere}`,
        countParams
      );
      const total = Number(totalRow?.total || 0);
      res.setHeader('X-Total-Count', String(total));
      res.setHeader('X-Limit-Applied', String(limit));
      res.setHeader('X-Offset-Applied', String(offset));
    }

    res.json(summaries);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategy summaries: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Bulk-archive paused strategies (research candidates cleanup)
router.post('/strategies/:apiKeyName/bulk-archive', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const apiKeyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
    if (!apiKeyRow?.id) {
      return res.status(404).json({ error: `API key not found: ${apiKeyName}` });
    }
    const apiKeyId = Number(apiKeyRow.id);

    // dryRun: only count, don't modify
    const dryRun = String(req.body?.dryRun ?? req.query.dryRun ?? '0').trim() !== '0';
    // olderThanDays: archive paused strategies older than N days (default 7)
    const olderThanDaysRaw = Number(req.body?.olderThanDays ?? req.query.olderThanDays ?? 7);
    const olderThanDays = Number.isFinite(olderThanDaysRaw) && olderThanDaysRaw >= 0 ? Math.floor(olderThanDaysRaw) : 7;

    const cutoffDate = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();

    const candidatesRows = await db.all(
      `SELECT id, name FROM strategies
       WHERE api_key_id = ?
         AND COALESCE(is_active, 1) = 0
         AND COALESCE(is_runtime, 0) = 0
         AND COALESCE(is_archived, 0) = 0
         AND (updated_at < ? OR updated_at IS NULL)
       ORDER BY id ASC`,
      [apiKeyId, cutoffDate]
    );

    const candidates = Array.isArray(candidatesRows) ? candidatesRows : [];
    const count = candidates.length;

    if (dryRun || count === 0) {
      return res.json({
        dryRun: true,
        count,
        olderThanDays,
        cutoffDate,
        sample: candidates.slice(0, 10).map((r: any) => ({ id: r.id, name: r.name })),
      });
    }

    const ids = candidates.map((r: any) => Number(r.id));
    // Archive in batches of 500 to avoid query size limits
    const BATCH = 500;
    let archived = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const result: any = await db.run(
        `UPDATE strategies SET is_archived = 1, updated_at = CURRENT_TIMESTAMP WHERE id IN (${placeholders})`,
        batch
      );
      archived += Number(result?.changes || 0);
    }

    logger.info(`Bulk-archived ${archived} paused strategies for API key ${apiKeyName}`);
    res.json({ dryRun: false, archived, olderThanDays, cutoffDate });
  } catch (error) {
    const err = error as Error;
    logger.error(`Bulk-archive error for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategies/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  const strategyIdNum = Number.parseInt(String(strategyId || ''), 10);

  if (!Number.isFinite(strategyIdNum) || strategyIdNum <= 0) {
    return res.status(400).json({ error: 'Invalid strategyId' });
  }

  try {
    const includeLotPreview = String(req.query.includeLotPreview || '0').trim() !== '0';
    const strategy = await getStrategyById(apiKeyName, strategyIdNum, { includeLotPreview });
    res.json(strategy);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategy ${strategyIdNum}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const strategies = await getStrategies(apiKeyName);
    res.json(strategies);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest strategies: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/backtest/run', async (req, res) => {
  if (backtestRunInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestRunInProgress = true;
    const saveResult = req.body?.saveResult !== false;
    const result = await runBacktest(req.body || {});
    let runId: number | null = null;

    if (saveResult) {
      runId = await saveBacktestRun(result);
      result.runId = runId;
    }

    res.json({ success: true, runId, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running backtest: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    backtestRunInProgress = false;
  }
});

router.get('/backtest/runs', async (req, res) => {
  const apiKeyName = req.query.apiKeyName ? String(req.query.apiKeyName) : undefined;
  const limitRaw = Number.parseInt(String(req.query.limit || '20'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 20;

  try {
    const rows = await listBacktestRuns(limit, apiKeyName);
    res.json(rows);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest runs: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/backtest/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const run = await getBacktestRun(id);
    if (!run) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json(run);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/backtest/runs/:id', async (req, res) => {
  const id = Number.parseInt(String(req.params.id || '0'), 10);

  if (!Number.isFinite(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid run id' });
  }

  try {
    const deleted = await deleteBacktestRun(id);
    if (!deleted) {
      return res.status(404).json({ error: 'Backtest run not found' });
    }
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting backtest run ${id}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trading-systems/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const systems = await listTradingSystems(apiKeyName);
    res.json(systems);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading trading systems: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  try {
    const system = await getTradingSystem(apiKeyName, parsedSystemId);
    res.json(system);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading trading system: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/trading-systems/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const system = await createTradingSystem(apiKeyName, req.body || {});
    res.json({ success: true, system });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error creating trading system: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  try {
    const system = await updateTradingSystem(apiKeyName, parsedSystemId, req.body || {});
    res.json({ success: true, system });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating trading system: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/trading-systems/:apiKeyName/:systemId/members', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  const members = Array.isArray(req.body) ? req.body : req.body?.members;
  const safeApply = req.body?.safeApply === true || req.body?.options?.safeApply === true;
  const safeOptions = {
    cancelRemovedOrders: req.body?.options?.cancelRemovedOrders,
    closeRemovedPositions: req.body?.options?.closeRemovedPositions,
    syncMemberActivation: req.body?.options?.syncMemberActivation,
  };

  try {
    if (safeApply) {
      const result = await replaceTradingSystemMembersSafely(
        apiKeyName,
        parsedSystemId,
        Array.isArray(members) ? members : [],
        safeOptions
      );
      return res.json({ success: true, ...result });
    }

    const system = await replaceTradingSystemMembers(apiKeyName, parsedSystemId, Array.isArray(members) ? members : []);
    res.json({ success: true, system });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error replacing trading system members: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/trading-systems/:apiKeyName/:systemId/activation', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  try {
    const system = await setTradingSystemActivation(
      apiKeyName,
      parsedSystemId,
      req.body?.isActive === true,
      req.body?.syncMembers === true
    );
    res.json({ success: true, system });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error applying trading system activation: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trading-systems/:apiKeyName/:systemId/frequency-diagnostics', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  try {
    const system = await getTradingSystem(apiKeyName, parsedSystemId);
    const targetTrades = Math.max(20, Math.min(5000, Number(req.query.targetTrades || 500)));
    const targetTradesPerDay = Math.max(1, Math.min(50, Number(req.query.targetTradesPerDay || 10)));

    const { sweep } = await loadCatalogAndSweepWithFallback();
    if (!sweep || !Array.isArray(sweep.evaluated) || sweep.evaluated.length === 0) {
      return res.status(400).json({ error: 'Sweep data unavailable for diagnostics' });
    }

    const dateFromMs = Date.parse(String(sweep.config?.dateFrom || ''));
    const dateToMs = Date.parse(String(sweep.config?.dateTo || ''));
    const inferredDays = Number.isFinite(dateFromMs) && Number.isFinite(dateToMs) && dateToMs > dateFromMs
      ? Math.max(1, Math.floor((dateToMs - dateFromMs) / 86_400_000))
      : 365;

    const byStrategyId = new Map<number, any>();
    for (const row of sweep.evaluated) {
      byStrategyId.set(Number(row.strategyId), row);
    }

    const enabledMembers = (system.members || []).filter((row) => Boolean(row.is_enabled));
    const memberDiagnostics = enabledMembers.map((member) => {
      const sweepRow = byStrategyId.get(Number(member.strategy_id)) || null;
      const trades = Math.max(0, Number(sweepRow?.tradesCount || 0));
      const tradesPerDay = Number((trades / inferredDays).toFixed(3));
      return {
        strategyId: Number(member.strategy_id),
        strategyName: String(member.strategy?.name || sweepRow?.strategyName || `#${member.strategy_id}`),
        market: String(sweepRow?.market || [member.strategy?.base_symbol, member.strategy?.quote_symbol].filter(Boolean).join('/')),
        interval: String(sweepRow?.interval || member.strategy?.interval || ''),
        weight: Number(member.weight || 0),
        trades,
        tradesPerDay,
        profitFactor: Number(sweepRow?.profitFactor || 0),
        maxDrawdownPercent: Number(sweepRow?.maxDrawdownPercent || 0),
      };
    });

    const weightedTrades = memberDiagnostics.reduce((acc, item) => acc + (item.trades * Math.max(0, item.weight || 0)), 0);
    const weightSum = memberDiagnostics.reduce((acc, item) => acc + Math.max(0, item.weight || 0), 0);
    const normalizedTrades = weightSum > 0 ? weightedTrades / weightSum : memberDiagnostics.reduce((acc, item) => acc + item.trades, 0) / Math.max(1, memberDiagnostics.length);
    const currentTradesEstimate = Number(normalizedTrades.toFixed(2));
    const currentTradesPerDayEstimate = Number((currentTradesEstimate / inferredDays).toFixed(3));

    const candidatePool = sweep.evaluated
      .map((row) => {
        const trades = Math.max(0, Number(row.tradesCount || 0));
        return {
          strategyId: Number(row.strategyId || 0),
          strategyName: String(row.strategyName || ''),
          market: String(row.market || ''),
          strategyType: String(row.strategyType || ''),
          marketMode: String(row.marketMode || ''),
          trades,
          tradesPerDay: Number((trades / inferredDays).toFixed(3)),
          profitFactor: Number(row.profitFactor || 0),
          maxDrawdownPercent: Number(row.maxDrawdownPercent || 0),
          score: Number(row.score || 0),
        };
      })
      .filter((row) => row.strategyId > 0)
      .sort((left, right) => {
        const leftDistance = Math.abs(left.tradesPerDay - targetTradesPerDay);
        const rightDistance = Math.abs(right.tradesPerDay - targetTradesPerDay);
        if (leftDistance !== rightDistance) {
          return leftDistance - rightDistance;
        }
        return right.score - left.score;
      });

    const minTrades = memberDiagnostics.length > 0 ? Math.min(...memberDiagnostics.map((item) => item.trades)) : 0;
    const maxTrades = memberDiagnostics.length > 0 ? Math.max(...memberDiagnostics.map((item) => item.trades)) : 0;

    const adjustable = memberDiagnostics.length >= 3 && maxTrades > minTrades * 1.25;
    const nearTarget = Math.abs(currentTradesEstimate - targetTrades) <= Math.max(40, targetTrades * 0.15);

    res.json({
      success: true,
      targetTrades,
      targetTradesPerDay,
      inferredSweepDays: inferredDays,
      currentTradesEstimate,
      currentTradesPerDayEstimate,
      range: {
        minTrades,
        maxTrades,
      },
      adjustable,
      nearTarget,
      recommendation: adjustable
        ? (nearTarget ? 'Current system is close to target and has frequency flexibility.' : 'System is flexible, tune members/weights to approach target trades.')
        : 'Low flexibility: add more diverse high/low frequency members from sweep.',
      memberDiagnostics,
      candidateSuggestions: candidatePool.slice(0, 12),
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error generating frequency diagnostics: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/trading-systems/:apiKeyName/:systemId/backtest', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  if (backtestRunInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestRunInProgress = true;
    const saveResult = req.body?.saveResult !== false;
    const result = await runTradingSystemBacktest(apiKeyName, parsedSystemId, req.body || {});
    let runId: number | null = null;

    if (saveResult) {
      runId = await saveBacktestRun(result);
      result.runId = runId;
    }

    res.json({ success: true, runId, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running trading system backtest: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    backtestRunInProgress = false;
  }
});

router.delete('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  try {
    await deleteTradingSystem(apiKeyName, parsedSystemId);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting trading system: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName/bulk-activation', async (req, res) => {
  const { apiKeyName } = req.params;
  const isActive = req.body?.isActive === true;

  try {
    const result = await setAllStrategiesActive(apiKeyName, isActive);
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error setting strategies activation for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName/:strategyId/cancel-orders', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const updated = await cancelStrategyOrders(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true, strategy: updated });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error cancelling strategy orders: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName/:strategyId/close-positions', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const updated = await closeStrategyPositions(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true, strategy: updated });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing strategy positions: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const strategy = req.body;
  try {
    const created = await createStrategy(apiKeyName, strategy);
    res.json(created);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error saving strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.put('/strategies/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  const routeStrategyId = Number.parseInt(strategyId, 10);

  if (!Number.isFinite(routeStrategyId) || routeStrategyId <= 0) {
    return res.status(400).json({ error: 'Invalid strategy id in URL' });
  }

  const incomingPatch = req.body && typeof req.body === 'object' ? req.body : {};
  const strategyPatch: Partial<Strategy> = {};

  for (const [field, value] of Object.entries(incomingPatch)) {
    if (!STRATEGY_PATCH_ALLOWED_FIELDS.has(field)) {
      return res.status(400).json({ error: `Unsupported strategy field: ${field}` });
    }

    if (field === 'id') {
      continue;
    }

    (strategyPatch as any)[field] = value;
  }

  const bodyStrategyIdRaw = incomingPatch.id;
  if (bodyStrategyIdRaw !== undefined && bodyStrategyIdRaw !== null) {
    const bodyStrategyId = Number.parseInt(String(bodyStrategyIdRaw), 10);
    if (!Number.isFinite(bodyStrategyId) || bodyStrategyId !== routeStrategyId) {
      return res.status(400).json({ error: 'Strategy ID mismatch between URL and body' });
    }
  }

  try {
    const updated = await updateStrategy(apiKeyName, routeStrategyId, strategyPatch, {
      allowBindingUpdate: true,
      source: 'api_put_strategy',
    });
    res.json(updated);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error updating strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.delete('/strategies/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await deleteStrategy(apiKeyName, Number.parseInt(strategyId, 10));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error deleting strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/execute-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    const result = await executeStrategy(apiKeyName, parseInt(strategyId));
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error executing strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/pause-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await pauseStrategy(apiKeyName, parseInt(strategyId));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error pausing strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/stop-strategy/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  try {
    await stopStrategy(apiKeyName, parseInt(strategyId));
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error stopping strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/close-position-percent/:apiKeyName/:strategyId', async (req, res) => {
  const { apiKeyName, strategyId } = req.params;
  const { symbol, percent, side } = req.body;
  try {
    await closePositionPercent(apiKeyName, parseInt(strategyId), symbol, percent, side);
    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing position: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/manual-order/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, qty, price } = req.body;
  try {
    const order = await placeManualOrder(apiKeyName, symbol, side, qty, price);
    res.json(order);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error placing manual order: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Маршруты для данных
router.get('/market-data/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, interval, limit } = req.query;
  logger.info(`Market data request: key=${apiKeyName}, symbol=${symbol}, interval=${interval}, limit=${limit}`);
  if (!symbol || !interval) {
    return res.status(400).json({ error: 'Missing required parameters: symbol, interval' });
  }
  try {
    const data = await getMarketData(apiKeyName, symbol as string, interval as string, parseInt(limit as string) || 100);
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Market data error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/order/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, qty, price } = req.body;
  try {
    const order = await placeOrder(apiKeyName, symbol, side, qty, price);
    res.json(order);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.get('/order/:apiKeyName/:id', async (req, res) => {
  const { apiKeyName, id } = req.params;
  try {
    const status = await getOrderStatus(apiKeyName, id);
    res.json(status);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.get('/balances/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  logger.info(`Balances request for key: ${apiKeyName}`);
  try {
    const balances = await getBalances(apiKeyName);
    logger.info(`Balances response for ${apiKeyName}: ${balances.length} items`);
    res.json(balances);
  } catch (error) {
    const err = error as Error;
    logger.error(`Balances error for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/positions/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol } = req.query;
  try {
    const positions = await getPositions(apiKeyName, symbol as string);
    res.json(positions);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

router.post('/positions/:apiKeyName/close-all', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const result = await closeAllPositions(apiKeyName);
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing all positions for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/orders/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;

  try {
    const orders = await getOpenOrders(apiKeyName, symbol);
    res.json(orders);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading open orders for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/strategy-trades/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 500));
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));

  try {
    const cutoffMs = Date.now() - days * 86400000;
    const rows = await db.all(
      `SELECT lte.id, lte.strategy_id AS strategyId, lte.trade_type AS tradeType,
              lte.side, lte.source_symbol AS symbol, lte.actual_price AS price,
              lte.position_size AS qty, lte.actual_time AS timestamp,
              lte.actual_fee AS fee
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ? AND lte.actual_time >= ?
       ORDER BY lte.actual_time DESC
       LIMIT ?`,
      [apiKeyName, cutoffMs, limit]
    );

    res.json(Array.isArray(rows) ? rows : []);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategy trades for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/trades/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const symbol = req.query.symbol ? String(req.query.symbol) : undefined;
  const limitRaw = Number.parseInt(String(req.query.limit || '200'), 10);
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 500) : 200;

  try {
    // Some exchanges require symbol for my trades.
    // If no symbol is provided, aggregate by active strategy symbols for this key.
    if (!symbol) {
      const symbolRows = await db.all(
        `SELECT DISTINCT
           UPPER(TRIM(COALESCE(base_symbol, ''))) AS base_symbol,
           UPPER(TRIM(COALESCE(quote_symbol, ''))) AS quote_symbol
         FROM strategies s
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE a.name = ?
           AND (
             TRIM(COALESCE(base_symbol, '')) <> ''
             OR TRIM(COALESCE(quote_symbol, '')) <> ''
           )`,
        [apiKeyName]
      ) as Array<{ base_symbol?: string; quote_symbol?: string }>;

      const recentEventSymbolRows = await db.all(
        `SELECT DISTINCT UPPER(TRIM(COALESCE(s.base_symbol, ''))) AS base_symbol
         FROM live_trade_events lte
         JOIN strategies s ON s.id = lte.strategy_id
         JOIN api_keys a ON a.id = s.api_key_id
         WHERE a.name = ?
           AND lte.actual_time >= (strftime('%s', 'now', '-30 days') * 1000)
           AND TRIM(COALESCE(s.base_symbol, '')) <> ''`,
        [apiKeyName]
      ) as Array<{ base_symbol?: string }>;

      const positionRows = await getPositions(apiKeyName).catch(() => []);

      const candidateSymbols = Array.from(new Set([
        ...(Array.isArray(symbolRows) ? symbolRows : []).flatMap((row) => [
          String(row?.base_symbol || '').trim().toUpperCase(),
          String(row?.quote_symbol || '').trim().toUpperCase(),
        ]),
        ...(Array.isArray(positionRows) ? positionRows : []).map((row: any) => String(row?.symbol || '').trim().toUpperCase()),
        ...(Array.isArray(recentEventSymbolRows) ? recentEventSymbolRows : []).map((row) => String(row?.base_symbol || '').trim().toUpperCase()),
      ].filter(Boolean)));

      if (!candidateSymbols.length) {
        return res.json([]);
      }

      const apiKeyInfo = await db.get('SELECT exchange FROM api_keys WHERE name = ?', [apiKeyName]) as { exchange?: string } | undefined;
      const exchange = String(apiKeyInfo?.exchange || '').toLowerCase();
      const symbolFanoutLimit = exchange === 'bingx' ? 8 : 24;
      const perSymbolLimit = Math.min(100, Math.max(10, Math.ceil(limit / Math.min(candidateSymbols.length, 10))));
      const aggregateErrors: string[] = [];
      const tradesBySymbol = await Promise.all(
        candidateSymbols.slice(0, symbolFanoutLimit).map(async (candidate) => {
          try {
            const list = await getRecentTrades(apiKeyName, candidate, perSymbolLimit);
            return Array.isArray(list) ? list : [];
          } catch (error) {
            const message = (error as Error)?.message || String(error);
            aggregateErrors.push(`${candidate}: ${message}`);
            return [];
          }
        })
      );

      const merged = tradesBySymbol.flat();
      const deduped = Array.from(new Map(
        merged.map((trade: any) => {
          const tradeId = String(trade?.tradeId || '');
          const tradeSymbol = String(trade?.symbol || '');
          const ts = String(trade?.timestamp || trade?.createdTime || '0');
          return [`${tradeId}|${tradeSymbol}|${ts}`, trade] as const;
        })
      ).values());

      deduped.sort((a: any, b: any) => {
        const ta = Number(a?.timestamp || a?.createdTime || 0);
        const tb = Number(b?.timestamp || b?.createdTime || 0);
        return tb - ta;
      });

      if (!deduped.length && aggregateErrors.length > 0) {
        const aggregateText = aggregateErrors.join(' | ');
        const isRateLimit = /100410|frequency limit|too many|429|rate limit/i.test(aggregateText);
        if (isRateLimit) {
          logger.warn(`Trade history rate-limited for ${apiKeyName}; returning empty trades snapshot`);
          return res.json([]);
        }

        const sample = aggregateErrors[0];
        return res.status(502).json({
          error: `Trade history temporarily unavailable for ${apiKeyName}: ${sample}`,
        });
      }

      return res.json(deduped.slice(0, limit));
    }

    const trades = await getRecentTrades(apiKeyName, symbol, limit);
    res.json(trades);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading trade history for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/orders/:apiKeyName/cancel-all', async (req, res) => {
  const { apiKeyName } = req.params;
  const symbol = req.body?.symbol ? String(req.body.symbol) : undefined;

  try {
    const result = await cancelAllOrders(apiKeyName, symbol);
    res.json({ success: true, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error cancelling orders for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/monitoring/:apiKeyName/snapshot', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const snapshot = await recordMonitoringSnapshot(apiKeyName);
    res.json(snapshot);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error recording monitoring snapshot for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/monitoring/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const capture = String(req.query.capture || '0') === '1' || String(req.query.capture || '').toLowerCase() === 'true';
  const limitRaw = Number.parseInt(String(req.query.limit || '240'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 240;
  const daysRaw = Number.parseInt(String(req.query.days || '0'), 10);
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : undefined;

  try {
    if (capture) {
      await recordMonitoringSnapshot(apiKeyName);
    }

    const points = await getMonitoringSnapshots(apiKeyName, limit, days);
    const latest = points.length > 0 ? points[points.length - 1] : await getMonitoringLatest(apiKeyName);

    res.json({ points, latest });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading monitoring data for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/api-keys/:apiKeyName/actions', async (req, res) => {
  const { apiKeyName } = req.params;
  const action = String(req.body?.action || '').trim();

  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  try {
    if (action === 'play-bots') {
      const result = await setAllStrategiesActive(apiKeyName, true);
      return res.json({ success: true, action, ...result });
    }

    if (action === 'pause-bots') {
      const result = await setAllStrategiesActive(apiKeyName, false);
      return res.json({ success: true, action, ...result });
    }

    if (action === 'cancel-orders') {
      const result = await cancelAllOrders(apiKeyName);
      return res.json({ success: true, action, result });
    }

    if (action === 'close-positions') {
      const result = await closeAllPositions(apiKeyName);
      return res.json({ success: true, action, ...result });
    }

    return res.status(400).json({ error: `Unsupported action: ${action}` });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running key action (${action}) for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.post('/controls/global', async (req, res) => {
  const action = String(req.body?.action || '').trim();
  if (!action) {
    return res.status(400).json({ error: 'action is required' });
  }

  const rows = await db.all('SELECT name FROM api_keys ORDER BY id ASC');
  const keyNames = rows.map((row: any) => String(row.name));
  const errors: Array<{ apiKey: string; error: string }> = [];

  for (const apiKeyName of keyNames) {
    try {
      if (action === 'play-bots') {
        await setAllStrategiesActive(apiKeyName, true);
      } else if (action === 'pause-bots') {
        await setAllStrategiesActive(apiKeyName, false);
      } else if (action === 'cancel-orders') {
        await cancelAllOrders(apiKeyName);
      } else if (action === 'close-positions') {
        await closeAllPositions(apiKeyName);
      } else {
        return res.status(400).json({ error: `Unsupported action: ${action}` });
      }
    } catch (error) {
      errors.push({
        apiKey: apiKeyName,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (errors.length > 0) {
    return res.status(207).json({ success: false, action, errors, processed: keyNames.length });
  }

  res.json({ success: true, action, processed: keyNames.length });
});

router.post('/positions/:apiKeyName/close-percent', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, side, percent } = req.body;
  try {
    if (!symbol || !side) {
      return res.status(400).json({ error: 'symbol and side are required' });
    }

    await closePositionPercentExchange(
      apiKeyName,
      String(symbol),
      side as 'Buy' | 'Sell',
      Number(percent)
    );

    res.json({ success: true });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error closing position percent: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/synthetic-chart/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { base, quote, baseCoef, quoteCoef, interval, limit } = req.query;
  logger.info(`Synthetic chart request for key: ${apiKeyName}`);
  try {
    const data = await calculateSyntheticOHLC(apiKeyName, base as string, quote as string, parseFloat(baseCoef as string), parseFloat(quoteCoef as string), interval as string, parseInt(limit as string));
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error calculating synthetic chart: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Получить все доступные пары с биржи
router.get('/symbols/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const symbols = await getAllSymbols(apiKeyName);
    res.json(symbols);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error fetching symbols: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

export default router;

import { Router } from 'express';
import bcrypt from 'bcrypt';
import {
  getMarketData,
  placeOrder,
  getOrderStatus,
  getBalances,
  formatExchangeErrorForUser,
  getPositions,
  ensureExchangeClientInitialized,
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
} from '../../bot/exchange';
import { calculateSyntheticOHLC } from '../../bot/synthetic';
import { getRiskSettings, updateRiskSettings } from '../../bot/risk';
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
} from '../../bot/strategy';
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
} from '../../bot/tradingSystems';
import {
  getMonitoringBundle,
  getMonitoringLatestBatch,
  getMonitoringTradeStats,
  recordMonitoringSnapshot,
} from '../../bot/monitoring';
import { loadSettings, saveApiKey, saveRiskSettings, normalizeExchangeName, ApiKey, RiskSettings, Strategy } from '../../config/settings';
import { db } from '../../utils/database';
import { authenticate, requirePlatformAdmin } from '../../utils/auth';
import logger from '../../utils/logger';
import { getGitUpdateJobStatus, getGitUpdateStatus, triggerGitUpdate } from '../../system/updateManager';
import { loadCatalogAndSweepWithFallback } from '../../saas/service';
import { saveBacktestRun } from '../../backtest/engine';
import { getAlgofundPositionHealthSummary } from '../../admin/positionHealth';
import { exchangeRequiresPassphrase } from './helpers';
import { backtestState } from './backtestState';
import fs from 'fs';
import path from 'path';

const adminRouter = Router();

const REPO_ROOT_DIR = path.resolve(__dirname, '../../../..');
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

      const lowerName = entry.name.toLowerCase();
      if (lowerName.includes('razgon') || lowerName.includes('synctrade')) {
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

const STRATEGY_PATCH_ALLOWED_FIELDS = new Set<string>([
  'id', 'name', 'is_active', 'display_on_chart', 'show_settings', 'show_chart', 'show_indicators',
  'show_positions_on_chart', 'show_trades_on_chart', 'show_values_each_bar', 'auto_update',
  'strategy_type', 'market_mode', 'take_profit_percent', 'price_channel_length', 'detection_source',
  'zscore_entry', 'zscore_exit', 'zscore_stop', 'base_symbol', 'quote_symbol', 'interval',
  'base_coef', 'quote_coef', 'long_enabled', 'short_enabled', 'lot_long_percent', 'lot_short_percent',
  'max_deposit', 'margin_type', 'leverage', 'fixed_lot', 'reinvest_percent', 'state', 'entry_ratio',
  'last_signal', 'last_action', 'last_error',
]);

adminRouter.get('/api-keys', requirePlatformAdmin, async (req, res) => {
  try {
    const { apiKeys } = await loadSettings();
    const tenantRows = await db.all(
      `SELECT t.display_name, t.slug, t.product_mode,
              COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name, '') AS api_key_name,
              COALESCE(ap.actual_enabled, 0) AS algofund_actual_enabled,
              COALESCE(ap.requested_enabled, 0) AS algofund_requested_enabled
       FROM tenants t
       LEFT JOIN algofund_profiles ap ON ap.tenant_id = t.id
       WHERE t.status != 'deleted'`,
    ).catch(() => []) as Array<{
      display_name: string;
      product_mode: string;
      slug?: string;
      api_key_name: string;
      algofund_actual_enabled: number;
      algofund_requested_enabled: number;
    }>;
    const tenantByApiKey = new Map<string, {
      displayName: string;
      slug?: string;
      productMode: string;
      algofundActualEnabled: boolean;
      algofundRequestedEnabled: boolean;
    }>();
    for (const row of tenantRows) {
      const key = String(row.api_key_name || '').trim();
      if (!key) continue;
      tenantByApiKey.set(key, {
        displayName: row.display_name,
        slug: row.slug,
        productMode: row.product_mode,
        algofundActualEnabled: Number(row.algofund_actual_enabled || 0) === 1,
        algofundRequestedEnabled: Number(row.algofund_requested_enabled || 0) === 1,
      });
    }
    const enriched = apiKeys.map((k: any) => {
      const tenant = tenantByApiKey.get(String(k.name || ''));
      if (!tenant) return k;
      const dematerialized = tenant.productMode === 'algofund_client'
        && (!tenant.algofundActualEnabled || !tenant.algofundRequestedEnabled);
      return {
        ...k,
        tenantDisplayName: tenant.displayName,
        tenantSlug: tenant.slug,
        tenantProductMode: tenant.productMode,
        algofundDematerialized: dematerialized,
      };
    });
    res.json(enriched);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading API keys: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/admin/position-health', requirePlatformAdmin, async (_req, res) => {
  try {
    const summary = await getAlgofundPositionHealthSummary();
    res.json({ success: true, ...summary });
  } catch (error) {
    const err = error as Error;
    logger.error(`position-health failed: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Per-exchange universe summary: how many active strategies + unique symbols per exchange
// Used by Dashboard to explain why positions differ across exchanges
adminRouter.get('/exchanges/universe', requirePlatformAdmin, async (_req, res) => {
  try {
    const rows = await db.all(
      `SELECT COALESCE(LOWER(k.exchange), '') AS exchange,
              COUNT(DISTINCT s.id)            AS active_strategies,
              COUNT(DISTINCT s.base_symbol)   AS unique_symbols,
              GROUP_CONCAT(DISTINCT s.base_symbol) AS symbols_csv,
              COUNT(DISTINCT k.id)            AS api_keys_count
       FROM api_keys k
       LEFT JOIN strategies s ON s.api_key_id = k.id
         AND COALESCE(s.is_active, 0) = 1
         AND COALESCE(s.is_archived, 0) = 0
         AND COALESCE(s.is_runtime, 0) = 1
       GROUP BY LOWER(k.exchange)
       ORDER BY exchange`
    ) as Array<{ exchange: string; active_strategies: number; unique_symbols: number; symbols_csv: string | null; api_keys_count: number }>;

    const result = rows.map((row) => {
      const symbols = String(row.symbols_csv || '')
        .split(',')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .sort();
      return {
        exchange: row.exchange,
        apiKeysCount: Number(row.api_keys_count || 0),
        activeStrategies: Number(row.active_strategies || 0),
        uniqueSymbols: Number(row.unique_symbols || 0),
        symbols,
      };
    });
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading exchanges/universe: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});
adminRouter.get('/key-status/:key', authenticate, async (req, res) => {
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

adminRouter.use(requirePlatformAdmin);

adminRouter.get('/admin/docs', async (_req, res) => {
  try {
    const docs = collectAdminMarkdownDocs().map(({ content, ...doc }) => doc);
    res.json({ success: true, docs });
  } catch (error) {
    const err = error as Error;
    logger.error(`Admin docs list error: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/admin/docs/content', async (req, res) => {
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
adminRouter.get('/logs', async (req, res) => {
  // Winston writes relative to process.cwd() (= backend/). Compiled __dirname is dist/api/routes,
  // so ../../logs points at dist/logs (missing) — prefer cwd, then fall back.
  const resolveLogPath = (fileName: string): string => {
    const candidates = [
      path.join(process.cwd(), 'logs', fileName),
      path.join(__dirname, '../../../logs', fileName),
      path.join(__dirname, '../../logs', fileName),
    ];
    return candidates.find((p) => fs.existsSync(p)) || candidates[0];
  };
  const combinedLogPath = resolveLogPath('combined.log');
  const errorLogPath = resolveLogPath('error.log');

  /** Tail last N non-empty lines without loading multi-GB log files into memory. */
  const readTailLines = (targetPath: string, maxLines: number): string[] => {
    if (!fs.existsSync(targetPath)) {
      return [];
    }
    const want = Math.max(1, maxLines);
    const stat = fs.statSync(targetPath);
    if (stat.size <= 0) return [];
    const fd = fs.openSync(targetPath, 'r');
    try {
      const chunkSize = Math.min(stat.size, Math.max(64 * 1024, want * 512));
      let position = stat.size;
      let carry = '';
      const lines: string[] = [];
      while (position > 0 && lines.length <= want) {
        const readSize = Math.min(chunkSize, position);
        position -= readSize;
        const buf = Buffer.alloc(readSize);
        fs.readSync(fd, buf, 0, readSize, position);
        carry = buf.toString('utf-8') + carry;
        const parts = carry.split('\n');
        carry = parts.shift() || '';
        for (let i = parts.length - 1; i >= 0; i -= 1) {
          const line = String(parts[i] || '').trim();
          if (line) lines.push(line);
          if (lines.length >= want) break;
        }
      }
      if (lines.length < want) {
        const head = String(carry || '').trim();
        if (head) lines.push(head);
      }
      return lines.reverse().slice(-want);
    } finally {
      fs.closeSync(fd);
    }
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
adminRouter.get('/system/update/status', async (req, res) => {
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

adminRouter.post('/system/update/run', async (req, res) => {
  try {
    const result = await triggerGitUpdate();
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error starting git update: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/system/update/job', async (req, res) => {
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
adminRouter.post('/api-keys', async (req, res) => {
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

adminRouter.put('/api-keys/:id', async (req, res) => {
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
        normalizeExchangeName(String(key.exchange || '')),
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

adminRouter.delete('/api-keys/:id', async (req, res) => {
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

// Проверка статуса чарта (volume, max lot)
adminRouter.get('/chart-status/:apiKeyName/:symbol', authenticate, async (req, res) => {
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
adminRouter.get('/risk-settings/:apiKeyName', async (req, res) => {
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

adminRouter.put('/risk-settings/:apiKeyName', async (req, res) => {
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
adminRouter.post('/strategies/copy-block', async (req, res) => {
  const {
    sourceApiKey,
    targetApiKey,
    replaceTarget,
    preserveActive,
    syncSymbols,
    sourceStrategyIds,
  } = req.body || {};

  if (!sourceApiKey || !targetApiKey) {
    return res.status(400).json({ error: 'sourceApiKey and targetApiKey are required' });
  }

  const normalizedSourceStrategyIds = Array.isArray(sourceStrategyIds)
    ? Array.from(new Set(sourceStrategyIds.map((value: unknown) => Number(value)).filter((id: number) => Number.isFinite(id) && id > 0)))
    : undefined;

  try {
    const result = await copyStrategyBlock(String(sourceApiKey), String(targetApiKey), {
      replaceTarget: replaceTarget !== false,
      preserveActive: preserveActive === true,
      syncSymbols: syncSymbols !== false,
      sourceStrategyIds: normalizedSourceStrategyIds,
    });
    res.json({ success: true, ...result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error copying strategy block: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/cards/materialize/:targetApiKeyName', async (req, res) => {
  const { targetApiKeyName } = req.params;
  const explicitSystemName = String(req.body?.systemName || '').trim();
  const gracefulMigration = req.body?.gracefulMigration === true
    || String(req.body?.gracefulMigration || '').toLowerCase() === 'true';

  try {
    const targetName = String(targetApiKeyName || '').trim();
    if (!targetName) {
      return res.status(400).json({ error: 'targetApiKeyName is required' });
    }

    const targetKey = await db.get('SELECT id, name FROM api_keys WHERE name = ?', [targetName]);
    if (!targetKey?.id) {
      return res.status(404).json({ error: `Target API key not found: ${targetName}` });
    }

    let systemName = explicitSystemName;
    if (!systemName) {
      const profile = await db.get(
        `SELECT published_system_name
         FROM algofund_profiles
         WHERE execution_api_key_name = ? AND COALESCE(published_system_name, '') <> ''
         ORDER BY updated_at DESC
         LIMIT 1`,
        [targetName]
      );
      systemName = String(profile?.published_system_name || '').trim();
    }

    if (!systemName) {
      return res.status(400).json({
        error: `No published system is configured for execution key ${targetName}`,
      });
    }

    const sourceSystem = await db.get(
      `SELECT ts.id AS system_id, ts.name AS system_name, ts.api_key_id, a.name AS source_api_key_name
       FROM trading_systems ts
       JOIN api_keys a ON a.id = ts.api_key_id
       WHERE ts.name = ?
       LIMIT 1`,
      [systemName]
    );

    if (!sourceSystem?.source_api_key_name) {
      return res.status(404).json({ error: `Published system not found: ${systemName}` });
    }

    // Collect strategy IDs from the source trading system members for filtered copy.
    // First try master_card_members (curated card), then fall back to trading_system_members.
    let cardMemberIds: number[] = [];
    const existingCard = await db.get(
      `SELECT id, metadata_json FROM master_cards WHERE code = ?`,
      [`CARD::${String(systemName).toUpperCase()}`]
    );
    if (existingCard?.id) {
      const mcMembers = await db.all(
        `SELECT strategy_id FROM master_card_members WHERE card_id = ? AND is_enabled = 1`,
        [existingCard.id]
      );
      cardMemberIds = (mcMembers || []).map((m: any) => Number(m.strategy_id));
    }
    if (cardMemberIds.length === 0) {
      // Fall back to trading_system_members from the source system
      const tsMembers = await db.all(
        `SELECT strategy_id FROM trading_system_members WHERE system_id = ? AND is_enabled = 1`,
        [Number(sourceSystem.system_id)]
      );
      cardMemberIds = (tsMembers || []).map((m: any) => Number(m.strategy_id));
    }

    cardMemberIds = Array.from(new Set(cardMemberIds.filter((id) => Number.isFinite(id) && id > 0)));
    if (cardMemberIds.length === 0) {
      return res.status(400).json({
        error: `No enabled member strategies found for system ${systemName}`,
      });
    }

    const sourceApiKeyName = String(sourceSystem.source_api_key_name);
    let compatibleMemberIds = cardMemberIds;
    let skippedIncompatible = 0;

    try {
      const [targetSymbols, sourceStrategies] = await Promise.all([
        getAllSymbols(targetName),
        getStrategies(sourceApiKeyName, { includeLotPreview: false }),
      ]);
      const availableSymbols = new Set(
        (Array.isArray(targetSymbols) ? targetSymbols : [])
          .map((symbol) => String(symbol || '').trim().toUpperCase())
          .filter((symbol) => symbol.length > 0)
      );

      if (availableSymbols.size > 0) {
        const sourceById = new Map<number, any>();
        for (const row of (Array.isArray(sourceStrategies) ? sourceStrategies : [])) {
          const id = Number((row as any)?.id || 0);
          if (Number.isFinite(id) && id > 0) {
            sourceById.set(id, row);
          }
        }

        const tenantRow = await db.get(
          `SELECT tenant_id
           FROM algofund_profiles
           WHERE execution_api_key_name = ?
           ORDER BY updated_at DESC
           LIMIT 1`,
          [targetName]
        );
        const tenantId = Number(tenantRow?.tenant_id || 0);

        const filteredIds: number[] = [];
        for (const strategyId of cardMemberIds) {
          const sourceStrategy = sourceById.get(strategyId);
          if (!sourceStrategy) {
            filteredIds.push(strategyId);
            continue;
          }

          const marketMode = String(sourceStrategy.market_mode || sourceStrategy.marketMode || '').trim().toLowerCase();
          const base = String(sourceStrategy.base_symbol || sourceStrategy.baseSymbol || '').trim().toUpperCase();
          const quote = String(sourceStrategy.quote_symbol || sourceStrategy.quoteSymbol || '').trim().toUpperCase();
          const market = (marketMode === 'mono' || !quote) ? base : `${base}/${quote}`;

          if (market && !availableSymbols.has(market)) {
            skippedIncompatible += 1;
            if (tenantId > 0) {
              await db.run(
                `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
                 VALUES (?, 'system', 'saas_materialize_pair_unavailable', ?, CURRENT_TIMESTAMP)`,
                [
                  tenantId,
                  JSON.stringify({
                    apiKeyName: targetName,
                    market,
                    strategyId,
                    reason: 'market_not_supported_on_exchange',
                    sourceSystem: systemName,
                  }),
                ]
              );
            }
            continue;
          }

          filteredIds.push(strategyId);
        }

        compatibleMemberIds = filteredIds;
      }
    } catch (error) {
      logger.warn(`Card materialize compatibility filter failed for ${targetName}: ${(error as Error).message}`);
    }

    if (compatibleMemberIds.length === 0) {
      return res.status(409).json({
        error: `No compatible member strategies for ${targetName}`,
        skippedIncompatible,
      });
    }

    // ── Graceful migration: convert currently-open runtime strategies to
    //    "saas_overlay_legacy" so the bot manages them to flat without opening
    //    new positions. They will be preserved through replaceTarget below.
    let overlayCount = 0;
    let overlayPairs: string[] = [];
    if (gracefulMigration) {
      const openRows = await db.all(
        `SELECT s.id, s.base_symbol, s.quote_symbol, s.interval, s.strategy_type
         FROM strategies s
         WHERE s.api_key_id = ?
           AND s.is_active = 1
           AND COALESCE(s.state, 'flat') <> 'flat'`,
        [targetKey.id]
      );
      if (Array.isArray(openRows) && openRows.length > 0) {
        const ids = openRows.map((r: any) => Number(r.id)).filter((n: number) => Number.isFinite(n) && n > 0);
        if (ids.length > 0) {
          const placeholders = ids.map(() => '?').join(',');
          await db.run(
            `UPDATE strategies
             SET origin = 'saas_overlay_legacy',
                 long_enabled = 0,
                 short_enabled = 0,
                 last_action = 'migrated_to_overlay_legacy',
                 updated_at = CURRENT_TIMESTAMP
             WHERE id IN (${placeholders})`,
            ids
          );
          overlayCount = ids.length;
          overlayPairs = Array.from(new Set(openRows.map((r: any) => String(r.base_symbol || '').toUpperCase()).filter(Boolean)));
          // Audit
          const tenantRow = await db.get(
            `SELECT tenant_id FROM algofund_profiles
             WHERE execution_api_key_name = ? ORDER BY updated_at DESC LIMIT 1`,
            [targetName]
          );
          const tenantId = Number(tenantRow?.tenant_id || 0);
          if (tenantId > 0) {
            await db.run(
              `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
               VALUES (?, 'system', 'saas_materialize_overlay_legacy', ?, CURRENT_TIMESTAMP)`,
              [
                tenantId,
                JSON.stringify({
                  apiKeyName: targetName,
                  newSystem: systemName,
                  overlayStrategyIds: ids,
                  overlayPairs,
                }),
              ]
            );
          }
          logger.info(
            `Graceful migration for ${targetName}: ${ids.length} runtime strategies marked as saas_overlay_legacy on pairs ${overlayPairs.join(',')}`
          );
        }
      }
    }

    const copyResult = await copyStrategyBlock(sourceApiKeyName, targetName, {
      replaceTarget: true,
      preserveActive: false,
      syncSymbols: false,
      sourceStrategyIds: compatibleMemberIds,
      preserveLegacyOverlay: gracefulMigration,
    });

    await db.run(
      `UPDATE strategies
       SET is_runtime = 1,
           is_archived = 0,
           auto_update = 1,
           origin = CASE
             WHEN COALESCE(origin, '') IN ('', 'manual') THEN 'card_materialized'
             ELSE origin
           END,
           updated_at = CURRENT_TIMESTAMP
       WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)`,
      [targetName]
    );

    // Apply per-card lot override (master_cards.metadata_json.lotPercentOverride)
    // to the just-materialized runtime strategies for this tenant's API key.
    try {
      const meta = existingCard?.metadata_json
        ? JSON.parse(String(existingCard.metadata_json)) as Record<string, unknown>
        : {};
      const lotRaw = Number((meta as { lotPercentOverride?: unknown })?.lotPercentOverride);
      if (Number.isFinite(lotRaw) && lotRaw > 0) {
        await db.run(
          `UPDATE strategies
           SET lot_long_percent = ?, lot_short_percent = ?, updated_at = CURRENT_TIMESTAMP
           WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
             AND COALESCE(origin, '') <> 'saas_overlay_legacy'`,
          [lotRaw, lotRaw, targetName]
        );
      }
      const reinvestRaw = Number((meta as { reinvestPercentOverride?: unknown })?.reinvestPercentOverride);
      if (Number.isFinite(reinvestRaw) && reinvestRaw >= 0) {
        await db.run(
          `UPDATE strategies
           SET reinvest_percent = ?, updated_at = CURRENT_TIMESTAMP
           WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
             AND COALESCE(origin, '') <> 'saas_overlay_legacy'`,
          [Math.min(100, Math.max(0, reinvestRaw)), targetName]
        );
      }
      const autoLot = (meta as { autoLotByChannelWidth?: unknown }).autoLotByChannelWidth === true ? 1 : 0;
      await db.run(
        `UPDATE strategies
         SET auto_lot_by_channel_width = ?, updated_at = CURRENT_TIMESTAMP
         WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
           AND COALESCE(strategy_type, '') NOT IN ('dca', 'dca_futures')
           AND COALESCE(origin, '') <> 'saas_overlay_legacy'`,
        [autoLot, targetName]
      );
      const dcaPerLegSl = (meta as { dcaPerLegSl?: unknown }).dcaPerLegSl === true ? 1 : 0;
      await db.run(
        `UPDATE strategies
         SET dca_per_leg_sl = ?, updated_at = CURRENT_TIMESTAMP
         WHERE api_key_id = (SELECT id FROM api_keys WHERE name = ?)
           AND strategy_type = 'dca'
           AND COALESCE(origin, '') <> 'saas_overlay_legacy'`,
        [dcaPerLegSl, targetName]
      );
    } catch (lotErr) {
      logger.warn(`Card lot override apply failed for ${targetName}: ${(lotErr as Error).message}`);
    }

    const cardCode = `CARD::${String(systemName).toUpperCase()}`;
    await db.run(
      `INSERT INTO master_cards (code, name, description, source_system_id, is_active, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(code) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         source_system_id = excluded.source_system_id,
         is_active = 1,
         updated_at = CURRENT_TIMESTAMP`,
      [cardCode, systemName, `Autogenerated from trading_systems: ${systemName}`, Number(sourceSystem.system_id)]
    );

    const cardRow = await db.get('SELECT id FROM master_cards WHERE code = ?', [cardCode]);
    if (cardRow?.id) {
      await db.run(
        `INSERT INTO card_deployments (
          card_id, tenant_id, execution_api_key_name, status, materialized_system_id,
          materialized_at, last_sync_at, sync_status, sync_error, created_at, updated_at
        )
        VALUES (?, NULL, ?, 'active', ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, 'ok', '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
        ON CONFLICT(card_id, execution_api_key_name) DO UPDATE SET
          status = 'active',
          materialized_system_id = excluded.materialized_system_id,
          materialized_at = CURRENT_TIMESTAMP,
          last_sync_at = CURRENT_TIMESTAMP,
          sync_status = 'ok',
          sync_error = '',
          updated_at = CURRENT_TIMESTAMP`,
        [Number(cardRow.id), targetName, Number(sourceSystem.system_id)]
      );
    }

    return res.json({
      success: true,
      targetApiKey: targetName,
      sourceApiKey: sourceApiKeyName,
      systemName,
      cardCode,
      sourceMembers: cardMemberIds.length,
      compatibleMembers: compatibleMemberIds.length,
      skippedIncompatible,
      gracefulMigration,
      overlayLegacyCount: overlayCount,
      overlayLegacyPairs: overlayPairs,
      ...copyResult,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error materializing card for ${targetApiKeyName}: ${err.message}`);
    return res.status(500).json({ error: err.message });
  }
});

// Lightweight counts endpoint — returns {total, running} per API key in a single query
adminRouter.get('/strategies/counts', async (_req, res) => {
  try {
    const rows: Array<{ api_key_name: string; total: number; running: number }> = await db.all(
      `SELECT a.name AS api_key_name,
              COUNT(*) AS total,
              SUM(CASE WHEN s.is_active = 1 THEN 1 ELSE 0 END) AS running
       FROM strategies s
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE COALESCE(s.is_archived, 0) = 0
         AND COALESCE(s.is_runtime, 0) = 1
       GROUP BY a.name`
    );
    const result: Record<string, { total: number; running: number }> = {};
    for (const row of rows) {
      result[row.api_key_name] = { total: row.total, running: row.running };
    }
    res.json(result);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategy counts: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/strategies/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const includeLotPreview = String(req.query.includeLotPreview || '1').trim() !== '0';
    const limitRaw = Number.parseInt(String(req.query.limit || ''), 10);
    const offsetRaw = Number.parseInt(String(req.query.offset || '0'), 10);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : undefined;
    const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? offsetRaw : 0;
    const marketTypeRaw = String(req.query.marketType || 'all').trim();
    const marketType = (marketTypeRaw === 'spot' || marketTypeRaw === 'futures') ? marketTypeRaw : 'all';

    const strategies = await getStrategies(apiKeyName, {
      includeLotPreview,
      limit,
      offset,
      marketType,
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

adminRouter.get('/strategies/:apiKeyName/summary', async (req, res) => {
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
adminRouter.post('/strategies/:apiKeyName/bulk-archive', async (req, res) => {
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

// Bulk-delete paused runtime strategies (SAAS dematerialization cleanup)
adminRouter.delete('/strategies/:apiKeyName/bulk-delete-runtime', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const apiKeyRow = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
    if (!apiKeyRow?.id) {
      return res.status(404).json({ error: `API key not found: ${apiKeyName}` });
    }
    const apiKeyId = Number(apiKeyRow.id);

    const dryRun = String(req.query.dryRun ?? '0').trim() !== '0';

    const candidatesRows = await db.all(
      `SELECT id, name FROM strategies
       WHERE api_key_id = ?
         AND COALESCE(is_runtime, 0) = 1
         AND COALESCE(is_active, 1) = 0
         AND COALESCE(is_archived, 0) = 0
       ORDER BY id ASC`,
      [apiKeyId]
    );
    const candidates = Array.isArray(candidatesRows) ? candidatesRows : [];
    const count = candidates.length;

    if (dryRun || count === 0) {
      return res.json({
        dryRun: true,
        count,
        sample: candidates.slice(0, 10).map((r: any) => ({ id: r.id, name: r.name })),
      });
    }

    const ids = candidates.map((r: any) => Number(r.id));
    const BATCH = 500;
    let deleted = 0;
    for (let i = 0; i < ids.length; i += BATCH) {
      const batch = ids.slice(i, i + BATCH);
      const placeholders = batch.map(() => '?').join(',');
      const result: any = await db.run(
        `DELETE FROM strategies WHERE id IN (${placeholders})`,
        batch
      );
      deleted += Number(result?.changes || 0);
    }

    logger.info(`Bulk-deleted ${deleted} paused runtime strategies for API key ${apiKeyName}`);
    res.json({ dryRun: false, deleted });
  } catch (error) {
    const err = error as Error;
    logger.error(`Bulk-delete-runtime error for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/strategies/:apiKeyName/:strategyId', async (req, res) => {
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


adminRouter.get('/trading-systems/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const marketTypeRaw = String(req.query.marketType || 'all').trim();
    const marketType = (marketTypeRaw === 'spot' || marketTypeRaw === 'futures') ? marketTypeRaw : 'all';
    const systems = await listTradingSystems(apiKeyName, { marketType });
    res.json(systems);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading trading systems: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
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

adminRouter.post('/trading-systems/:apiKeyName', async (req, res) => {
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

adminRouter.put('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
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

adminRouter.post('/trading-systems/:apiKeyName/:systemId/dca-futures-member', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);
  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }
  try {
    const body = req.body || {};
    const baseSymbol = String(body.base_symbol || '').trim().toUpperCase();
    if (!baseSymbol) return res.status(400).json({ error: 'base_symbol is required' });

    const name = String(body.name || `DCA-F ${baseSymbol} [TS${parsedSystemId}]`).trim();
    const baseAmountUsdt = Math.max(1, Number(body.dcaf_base_amount_usdt ?? 10));
    const stepPercent = Math.max(0.1, Number(body.dcaf_step_percent ?? 2));
    const maxOrders = Math.max(0, Math.floor(Number(body.dcaf_max_orders ?? 3)));
    const orderMultiplier = Math.max(1, Number(body.dcaf_order_multiplier ?? 1.5));
    const tpPercent = Math.max(0.1, Number(body.dcaf_tp_percent ?? 2.5));
    const slPercent = Math.max(0, Number(body.dcaf_sl_percent ?? 0));
    const orderType = String(body.dcaf_order_type ?? 'market') === 'maker' ? 'maker' : 'market';
    const autoOpen = body.dcaf_auto_open !== false ? 1 : 0; // default true for TS member
    const leverage = Math.max(1, Math.floor(Number(body.dcaf_leverage ?? 1)));

    // Check TS exists and belongs to this apiKey
    const ts = await db.get<{ id: number }>(
      `SELECT ts.id FROM trading_systems ts
       JOIN api_keys ak ON ak.id = ts.api_key_id
       WHERE ts.id = ? AND ak.name = ?`,
      [parsedSystemId, apiKeyName],
    );
    if (!ts) return res.status(404).json({ error: 'Trading system not found' });

    const draft = {
      name,
      strategy_type: 'dca_futures',
      market_mode: 'mono',
      market_type: 'futures',
      base_symbol: baseSymbol,
      quote_symbol: 'USDT',
      is_active: true,
      auto_update: true,
      long_enabled: true,
      short_enabled: true,
    };

    const created = await createStrategy(apiKeyName, draft as any, { allowActivePairConflict: true });
    if (!created.id) return res.status(500).json({ error: 'Strategy created but id missing' });

    await db.run(
      `UPDATE strategies
       SET dcaf_base_amount_usdt = ?,
           dcaf_step_percent = ?,
           dcaf_max_orders = ?,
           dcaf_order_multiplier = ?,
           dcaf_tp_percent = ?,
           dcaf_sl_percent = ?,
           dcaf_order_type = ?,
           dcaf_auto_open = ?,
           dcaf_leverage = ?,
           dcaf_state = 'idle',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [baseAmountUsdt, stepPercent, maxOrders, orderMultiplier, tpPercent, slPercent, orderType, autoOpen, leverage, created.id],
    );

    // Add as TS member
    const maxPos = (await db.get<{ m: number }>(
      `SELECT COALESCE(MAX(position), 0) AS m FROM trading_system_members WHERE system_id = ?`,
      [parsedSystemId],
    ))?.m || 0;
    await db.run(
      `INSERT INTO trading_system_members (system_id, strategy_id, position, is_active)
       VALUES (?, ?, ?, 1)`,
      [parsedSystemId, created.id, maxPos + 1],
    );

    logger.info(`[dca-futures-member] created strategy id=${created.id} name=${name} and added to TS${parsedSystemId}`);
    res.json({
      strategyId: created.id,
      name,
      systemId: parsedSystemId,
      dcaf_auto_open: autoOpen,
      dcaf_base_amount_usdt: baseAmountUsdt,
      dcaf_step_percent: stepPercent,
      dcaf_max_orders: maxOrders,
      dcaf_tp_percent: tpPercent,
      dcaf_sl_percent: slPercent,
      dcaf_leverage: leverage,
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error adding dca-futures member: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.put('/trading-systems/:apiKeyName/:systemId/members', async (req, res) => {
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

adminRouter.post('/trading-systems/:apiKeyName/:systemId/activation', async (req, res) => {
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

adminRouter.get('/trading-systems/:apiKeyName/:systemId/frequency-diagnostics', async (req, res) => {
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

adminRouter.post('/trading-systems/:apiKeyName/:systemId/backtest', async (req, res) => {
  const { apiKeyName, systemId } = req.params;
  const parsedSystemId = Number.parseInt(systemId, 10);

  if (!Number.isFinite(parsedSystemId) || parsedSystemId <= 0) {
    return res.status(400).json({ error: 'Invalid trading system id' });
  }

  if (backtestState.runInProgress) {
    return res.status(429).json({
      error: 'Backtest already running. Wait for current run to finish before starting a new one.',
    });
  }

  try {
    backtestState.runInProgress = true;
    const saveResult = req.body?.saveResult !== false;
    const result = await runTradingSystemBacktest(apiKeyName, parsedSystemId, req.body || {});
    let runId: number | null = null;

    if (saveResult) {
      runId = await saveBacktestRun(result);
      result.runId = runId ?? undefined;
    }

    res.json({ success: true, runId, result });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error running trading system backtest: ${err.message}`);
    res.status(500).json({ error: err.message });
  } finally {
    backtestState.runInProgress = false;
  }
});

adminRouter.delete('/trading-systems/:apiKeyName/:systemId', async (req, res) => {
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

adminRouter.post('/strategies/:apiKeyName/bulk-activation', async (req, res) => {
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

adminRouter.post('/strategies/:apiKeyName/:strategyId/cancel-orders', async (req, res) => {
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

adminRouter.post('/strategies/:apiKeyName/:strategyId/close-positions', async (req, res) => {
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

adminRouter.post('/strategies/:apiKeyName/periodic-buy', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const body = req.body || {};
    const baseSymbol = String(body.base_symbol || '').trim().toUpperCase();
    const quoteSymbol = String(body.quote_symbol || 'USDT').trim().toUpperCase();
    if (!baseSymbol) {
      return res.status(400).json({ error: 'base_symbol is required' });
    }

    const name = String(body.name || `Periodic Buy ${baseSymbol}`).trim();
    const intervalHours = Math.max(1, Number(body.pb_interval_hours || 24));
    const amountMode = String(body.pb_amount_mode || 'percent') === 'fixed_usdt' ? 'fixed_usdt' : 'percent';
    const amountValue = Math.max(0.01, Number(body.pb_amount_value || 5));
    const orderType = String(body.pb_order_type || 'market') === 'maker' ? 'maker' : 'market';
    const maxTotalInvested = Math.max(0, Number(body.pb_max_total_invested_usdt || 0));
    const sellOnTp = String(body.pb_sell_on_tp || '0') !== '0' && body.pb_sell_on_tp !== false;
    const tpPercent = Math.max(0.1, Number(body.pb_tp_percent || 15));

    const draft = {
      name,
      strategy_type: 'periodic_buy',
      market_mode: 'mono',
      market_type: 'spot',
      base_symbol: baseSymbol,
      quote_symbol: quoteSymbol,
      is_active: true,
      auto_update: true,
      long_enabled: true,
      short_enabled: false,
    };

    const created = await createStrategy(apiKeyName, draft as any, { allowActivePairConflict: true });
    if (!created.id) {
      return res.status(500).json({ error: 'Strategy created but id missing' });
    }

    // Save pb_* fields with a direct UPDATE (createStrategy doesn't handle them)
    await db.run(
      `UPDATE strategies
       SET pb_interval_hours = ?,
           pb_amount_mode = ?,
           pb_amount_value = ?,
           pb_order_type = ?,
           pb_max_total_invested_usdt = ?,
           pb_sell_on_tp = ?,
           pb_tp_percent = ?,
           market_type = 'spot',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [intervalHours, amountMode, amountValue, orderType, maxTotalInvested, sellOnTp ? 1 : 0, tpPercent, created.id]
    );

    res.json({ ...created, pb_interval_hours: intervalHours, pb_amount_mode: amountMode, pb_amount_value: amountValue, pb_order_type: orderType, pb_max_total_invested_usdt: maxTotalInvested, pb_sell_on_tp: sellOnTp, pb_tp_percent: tpPercent, market_type: 'spot' });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error creating periodic-buy strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/strategies/:apiKeyName/dca', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const body = req.body || {};
    const baseSymbol = String(body.base_symbol || '').trim().toUpperCase();
    const quoteSymbol = String(body.quote_symbol || 'USDT').trim().toUpperCase();
    if (!baseSymbol) return res.status(400).json({ error: 'base_symbol is required' });

    const name = String(body.name || `DCA ${baseSymbol}`).trim();
    const marketType = String(body.market_type || 'spot') === 'futures' ? 'futures' : 'spot';
    const baseAmountUsdt = Math.max(1, Number(body.dca_base_amount_usdt || 10));
    const stepPercent = Math.max(0.1, Number(body.dca_step_percent || 2));
    const maxOrders = Math.max(0, Math.floor(Number(body.dca_max_orders || 5)));
    const orderMultiplier = Math.max(1, Number(body.dca_order_multiplier || 1));
    const tpPercent = Math.max(0.1, Number(body.dca_tp_percent || 3));
    const slPercent = Math.max(0, Number(body.dca_sl_percent || 0));
    const orderType = String(body.dca_order_type || 'market') === 'maker' ? 'maker' : 'market';

    const draft = {
      name,
      strategy_type: 'dca',
      market_mode: 'mono',
      market_type: marketType,
      base_symbol: baseSymbol,
      quote_symbol: quoteSymbol,
      is_active: true,
      auto_update: true,
      long_enabled: true,
      short_enabled: false,
    };

    const created = await createStrategy(apiKeyName, draft as any, { allowActivePairConflict: true });
    if (!created.id) return res.status(500).json({ error: 'Strategy created but id missing' });

    await db.run(
      `UPDATE strategies
       SET dca_base_amount_usdt = ?,
           dca_step_percent = ?,
           dca_max_orders = ?,
           dca_order_multiplier = ?,
           dca_tp_percent = ?,
           dca_sl_percent = ?,
           dca_order_type = ?,
           dca_state = 'idle',
           market_type = ?,
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [baseAmountUsdt, stepPercent, maxOrders, orderMultiplier, tpPercent, slPercent, orderType, marketType, created.id]
    );

    res.json({ ...created, dca_base_amount_usdt: baseAmountUsdt, dca_step_percent: stepPercent, dca_max_orders: maxOrders, dca_order_multiplier: orderMultiplier, dca_tp_percent: tpPercent, dca_sl_percent: slPercent, dca_order_type: orderType, market_type: marketType });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error creating DCA strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/strategies/:apiKeyName/dca-futures', async (req, res) => {
  const { apiKeyName } = req.params;
  try {
    const body = req.body || {};
    const baseSymbol = String(body.base_symbol || '').trim().toUpperCase();
    const quoteSymbol = String(body.quote_symbol || 'USDT').trim().toUpperCase();
    if (!baseSymbol) return res.status(400).json({ error: 'base_symbol is required' });

    const name = String(body.name || `DCA-F ${baseSymbol}`).trim();
    const baseAmountUsdt = Math.max(1, Number(body.dcaf_base_amount_usdt ?? 10));
    const stepPercent = Math.max(0.1, Number(body.dcaf_step_percent ?? 2));
    const maxOrders = Math.max(0, Math.floor(Number(body.dcaf_max_orders ?? 3)));
    const orderMultiplier = Math.max(1, Number(body.dcaf_order_multiplier ?? 1.5));
    const tpPercent = Math.max(0.1, Number(body.dcaf_tp_percent ?? 2.5));
    const slPercent = Math.max(0, Number(body.dcaf_sl_percent ?? 0));
    const orderType = String(body.dcaf_order_type ?? 'market') === 'maker' ? 'maker' : 'market';
    const autoOpen = body.dcaf_auto_open ? 1 : 0;
    const leverage = Math.max(1, Math.floor(Number(body.dcaf_leverage ?? 1)));

    const draft = {
      name,
      strategy_type: 'dca_futures',
      market_mode: 'mono',
      market_type: 'futures',
      base_symbol: baseSymbol,
      quote_symbol: quoteSymbol,
      is_active: true,
      auto_update: true,
      long_enabled: true,
      short_enabled: true,
    };

    const created = await createStrategy(apiKeyName, draft as any, { allowActivePairConflict: true });
    if (!created.id) return res.status(500).json({ error: 'Strategy created but id missing' });

    await db.run(
      `UPDATE strategies
       SET dcaf_base_amount_usdt = ?,
           dcaf_step_percent = ?,
           dcaf_max_orders = ?,
           dcaf_order_multiplier = ?,
           dcaf_tp_percent = ?,
           dcaf_sl_percent = ?,
           dcaf_order_type = ?,
           dcaf_auto_open = ?,
           dcaf_leverage = ?,
           dcaf_state = 'idle',
           market_type = 'futures',
           updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [baseAmountUsdt, stepPercent, maxOrders, orderMultiplier, tpPercent, slPercent, orderType, autoOpen, leverage, created.id],
    );

    res.json({
      ...created,
      dcaf_base_amount_usdt: baseAmountUsdt,
      dcaf_step_percent: stepPercent,
      dcaf_max_orders: maxOrders,
      dcaf_order_multiplier: orderMultiplier,
      dcaf_tp_percent: tpPercent,
      dcaf_sl_percent: slPercent,
      dcaf_order_type: orderType,
      dcaf_auto_open: autoOpen,
      dcaf_leverage: leverage,
      market_type: 'futures',
    });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error creating DCA-Futures strategy: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/strategies/:apiKeyName', async (req, res) => {
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

adminRouter.put('/strategies/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.delete('/strategies/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.post('/execute-strategy/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.post('/pause-strategy/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.post('/stop-strategy/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.post('/close-position-percent/:apiKeyName/:strategyId', async (req, res) => {
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

adminRouter.post('/manual-order/:apiKeyName', async (req, res) => {
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

const CHART_ROUTE_TIMEOUT_MS = 45_000;

const withChartRouteTimeout = async <T>(promise: Promise<T>, label: string): Promise<T> => (
  Promise.race([
    promise,
    new Promise<T>((_resolve, reject) => {
      setTimeout(
        () => reject(new Error(`${label} timeout after ${CHART_ROUTE_TIMEOUT_MS}ms`)),
        CHART_ROUTE_TIMEOUT_MS,
      );
    }),
  ])
);

// Маршруты для данных
adminRouter.get('/market-data/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol, interval, limit } = req.query;
  logger.info(`Market data request: key=${apiKeyName}, symbol=${symbol}, interval=${interval}, limit=${limit}`);
  if (!symbol || !interval) {
    return res.status(400).json({ error: 'Missing required parameters: symbol, interval' });
  }
  try {
    await ensureExchangeClientInitialized(apiKeyName);
    const safeLimit = Math.min(500, Math.max(50, parseInt(limit as string, 10) || 220));
    const data = await withChartRouteTimeout(
      getMarketData(apiKeyName, symbol as string, interval as string, safeLimit),
      `market-data ${symbol}`,
    );
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Market data error: ${err.message}`);
    const status = /timeout/i.test(err.message) ? 504 : 500;
    res.status(status).json({ error: err.message });
  }
});

adminRouter.post('/order/:apiKeyName', async (req, res) => {
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

adminRouter.get('/order/:apiKeyName/:id', async (req, res) => {
  const { apiKeyName, id } = req.params;
  try {
    const status = await getOrderStatus(apiKeyName, id);
    res.json(status);
  } catch (error) {
    const err = error as Error;
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/balances/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  logger.info(`Balances request for key: ${apiKeyName}`);
  try {
    try { await ensureExchangeClientInitialized(apiKeyName); } catch { /* getBalances will surface a clear error */ }
    const balances = await getBalances(apiKeyName);
    logger.info(`Balances response for ${apiKeyName}: ${balances.length} items`);
    res.json(balances);
  } catch (error) {
    const err = error as Error;
    logger.error(`Balances error for ${apiKeyName}: ${err.message}`);
    res.status(500).json({
      error: formatExchangeErrorForUser(err, apiKeyName),
      code: /40018|无效的IP|invalid\s*ip/i.test(err.message) ? 'WEEX_IP_WHITELIST' : 'EXCHANGE_ERROR',
    });
  }
});

adminRouter.get('/admin/egress-ip', requirePlatformAdmin, (_req, res) => {
  const ip = String(process.env.BTDD_EGRESS_IP || process.env.VPS_PUBLIC_IP || '176.57.184.98').trim();
  res.json({ ip });
});

adminRouter.get('/positions/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { symbol } = req.query;

  const withTimeout = async <T>(promise: Promise<T>, timeoutMs: number): Promise<T> => {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        setTimeout(() => reject(new Error('positions request timeout')), timeoutMs);
      }),
    ]);
  };

  const isSoftPositionsError = (message: string): boolean => {
    return /client not initialized|not initialized|temporarily unavailable|rate limit|too many|429|timeout|positions fetch timeout|network error|service unavailable/i.test(message);
  };

  try {
    // Ensure client is lazy-initialized (e.g. WEEX keys may not be eagerly initialized at boot).
    try { await ensureExchangeClientInitialized(apiKeyName); } catch { /* tolerate init failure, getPositions will throw a clear error */ }
    const positions = await withTimeout(getPositions(apiKeyName, symbol as string), 15000);
    res.json(positions);
  } catch (error) {
    const err = error as Error;
    if (isSoftPositionsError(err.message || '')) {
      logger.warn(`Positions temporary fallback for ${apiKeyName}: ${err.message}`);
      return res.json([]);
    }
    res.status(500).json({
      error: formatExchangeErrorForUser(err, apiKeyName),
      code: /40018|无效的IP|invalid\s*ip/i.test(err.message) ? 'WEEX_IP_WHITELIST' : 'EXCHANGE_ERROR',
    });
  }
});

adminRouter.post('/positions/:apiKeyName/close-all', async (req, res) => {
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

adminRouter.get('/orders/:apiKeyName', async (req, res) => {
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

adminRouter.get('/strategy-trades/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const limit = Math.min(5000, Math.max(1, Number(req.query.limit) || 2000));
  const days = Math.min(365, Math.max(1, Number(req.query.days) || 90));
  const strategyIdRaw = Number(req.query.strategyId);
  const strategyId = Number.isFinite(strategyIdRaw) && strategyIdRaw > 0 ? Math.floor(strategyIdRaw) : null;

  try {
    const cutoffMs = Date.now() - days * 86400000;
    const params: Array<string | number> = [apiKeyName, cutoffMs];
    let strategyFilter = '';
    if (strategyId !== null) {
      strategyFilter = ' AND lte.strategy_id = ?';
      params.push(strategyId);
    }
    params.push(limit);

    const rows = await db.all(
      `SELECT lte.id, lte.strategy_id AS strategyId, lte.trade_type AS tradeType,
              lte.side, lte.source_symbol AS symbol, lte.actual_price AS price,
              lte.position_size AS qty, lte.actual_time AS timestamp,
              lte.actual_fee AS fee, lte.event_origin AS eventOrigin
       FROM live_trade_events lte
       JOIN strategies s ON s.id = lte.strategy_id
       JOIN api_keys a ON a.id = s.api_key_id
       WHERE a.name = ? AND lte.actual_time >= ?${strategyFilter}
       ORDER BY lte.actual_time DESC
       LIMIT ?`,
      params
    );

    res.json(Array.isArray(rows) ? rows : []);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading strategy trades for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/trades/:apiKeyName', async (req, res) => {
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

      // Bybit endpoint can return unified execution history without per-symbol fanout.
      // This avoids partial visibility when some symbol-specific calls fail or are rate-limited.
      if (exchange.includes('bybit')) {
        const allTrades = await getRecentTrades(apiKeyName, undefined, Math.min(500, Math.max(limit * 3, 200)));
        const filtered = (Array.isArray(allTrades) ? allTrades : []).filter((trade: any) => {
          const tradeSymbol = String(trade?.symbol || '').trim().toUpperCase();
          return candidateSymbols.includes(tradeSymbol);
        });

        const deduped = Array.from(new Map(
          filtered.map((trade: any) => {
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

        return res.json(deduped.slice(0, limit));
      }

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

adminRouter.post('/orders/:apiKeyName/cancel-all', async (req, res) => {
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

adminRouter.post('/monitoring/:apiKeyName/snapshot', async (req, res) => {
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

/** Bulk latest snapshots for admin monitoring table (one SQL, optional trade stats). */
adminRouter.get('/monitoring-summary', requirePlatformAdmin, async (req, res) => {
  try {
    const rawKeys = String(req.query.keys || '').trim();
    const fromBody = Array.isArray(req.body?.keys) ? req.body.keys : [];
    const names = [
      ...rawKeys.split(',').map((s) => s.trim()).filter(Boolean),
      ...fromBody.map((s: unknown) => String(s || '').trim()).filter(Boolean),
    ];
    const unique = [...new Set(names)];
    if (unique.length === 0) {
      return res.json({ success: true, rows: [] });
    }
    if (unique.length > 500) {
      return res.status(400).json({ error: 'Too many keys (max 500)' });
    }

    const includeTrades = String(req.query.includeTrades || '0') === '1'
      || String(req.query.includeTrades || '').toLowerCase() === 'true';

    const latestByKey = await getMonitoringLatestBatch(unique);
    const rows = await Promise.all(unique.map(async (apiKeyName) => {
      const latest = latestByKey[apiKeyName] || null;
      let tradeStats = { trades24h: 0, lastTradeAt: null as string | null };
      if (includeTrades) {
        tradeStats = await getMonitoringTradeStats(apiKeyName).catch(() => ({
          trades24h: 0,
          lastTradeAt: null,
        }));
      }
      return {
        apiKeyName,
        latest,
        tradeStats,
      };
    }));

    res.json({ success: true, rows });
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading monitoring-summary: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.get('/monitoring/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const capture = String(req.query.capture || '0') === '1' || String(req.query.capture || '').toLowerCase() === 'true';
  const limitRaw = Number.parseInt(String(req.query.limit || '240'), 10);
  const limit = Number.isFinite(limitRaw) ? limitRaw : 240;
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

  try {
    if (capture) {
      await recordMonitoringSnapshot(apiKeyName);
    }

    const bundle = await getMonitoringBundle(apiKeyName, {
      limit,
      days,
      all: allPeriod,
      includeTrades,
      includeTradesRows,
      includeTradeMarkers,
    });

    res.json(bundle);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error loading monitoring data for ${apiKeyName}: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

adminRouter.post('/api-keys/:apiKeyName/actions', async (req, res) => {
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

adminRouter.post('/controls/global', async (req, res) => {
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

adminRouter.post('/positions/:apiKeyName/close-percent', async (req, res) => {
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

adminRouter.get('/synthetic-chart/:apiKeyName', async (req, res) => {
  const { apiKeyName } = req.params;
  const { base, quote, baseCoef, quoteCoef, interval, limit } = req.query;
  logger.info(`Synthetic chart request for key: ${apiKeyName}`);
  try {
    await ensureExchangeClientInitialized(apiKeyName);
    const safeLimit = Math.min(500, Math.max(50, parseInt(limit as string, 10) || 220));
    const data = await withChartRouteTimeout(
      calculateSyntheticOHLC(
        apiKeyName,
        base as string,
        quote as string,
        parseFloat(baseCoef as string),
        parseFloat(quoteCoef as string),
        interval as string,
        safeLimit,
      ),
      `synthetic-chart ${base}/${quote}`,
    );
    res.json(data);
  } catch (error) {
    const err = error as Error;
    logger.error(`Error calculating synthetic chart: ${err.message}`);
    const status = /timeout/i.test(err.message) ? 504 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Получить все доступные пары с биржи
adminRouter.get('/symbols/:apiKeyName', async (req, res) => {
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

export default adminRouter;

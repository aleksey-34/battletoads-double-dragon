/**
 * Research circuit API routes: /api/research/*
 *
 * Admin-only. All routes require the standard admin Bearer token.
 * Research DB is initialized lazily on first request.
 */
import { Router } from 'express';
import { requirePlatformAdmin } from '../utils/auth';
import { initResearchDb } from '../research/db';
import {
  listProfiles,
  getProfileById,
  createProfile,
  updateProfile,
  archiveProfile,
  publishProfileToRuntime,
  revokePublishedProfile,
  registerSweepRun,
  importSweepCandidates,
} from '../research/profileService';
import {
  enqueuePreviewJob,
  getPreviewJob,
  getPreviewResult,
} from '../research/previewService';
import {
  buildPresetsForOffer,
  getPreset,
  listOfferIds,
} from '../research/presetBuilder';
import {
  analyzeDailySweepGap,
  getDailySweepBackfillStatus,
  getResearchDbObservability,
  listSchedulerJobs,
  runDailySweepGapBackfill,
  startDailySweepGapBackfillJob,
  updateDailySweepBackfillMode,
  runSchedulerJobNow,
  updateSchedulerJob,
} from '../research/schedulerService';
import {
  startFullHistoricalSweepJob as startHistoricalSweepJob,
  getFullHistoricalSweepStatus as getHistoricalSweepStatus,
  abortRunningFullHistoricalSweepJob as abortHistoricalSweepJob,
} from '../research/fullHistoricalSweepService';
import { importHistoricalArtifactsToResearch, importCandidatesFromSweepCatalog } from '../research/importService';
import {
  listResearchSweepTasks,
  listSweepPairs,
  markResearchSweepTasks,
  runSweepFromManualMarkets,
  runSweepFromSelectedTasks,
  setResearchSweepTaskSelection,
  syncClientBacktestRequestsToResearchTasks,
} from '../research/taskService';
import { db } from '../utils/database';
import logger from '../utils/logger';
import { getStrategies } from '../bot/strategy';
import { createTradingSystem, runTradingSystemBacktest } from '../bot/tradingSystems';
import { loadCatalogAndSweepWithFallback } from '../saas/service';

const router = Router();

type SweepRunMode = 'light' | 'heavy';

const parseSweepRunMode = (value: unknown): SweepRunMode => {
  const text = String(value || '').trim().toLowerCase();
  return text === 'heavy' ? 'heavy' : 'light';
};

// ── Ensure research DB is ready on every request ──────────────────────────────
router.use(async (_req, _res, next) => {
  try {
    await initResearchDb();
    next();
  } catch (err) {
    next(err);
  }
});

// ── All research routes require platform admin auth ───────────────────────────
router.use(requirePlatformAdmin);

// ═══════════════════════════════════════════════════════════════════════════════
// PROFILES
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/profiles', async (req, res) => {
  try {
    const status = String(req.query.status || '') || undefined;
    const sweep_run_id = req.query.sweep_run_id ? Number(req.query.sweep_run_id) : undefined;
    const limit = req.query.limit ? Math.min(Number(req.query.limit), 500) : 100;
    const offset = req.query.offset ? Number(req.query.offset) : 0;
    const profiles = await listProfiles({
      status: status as any,
      sweep_run_id,
      limit,
      offset,
    });
    res.json({ profiles, limit, offset });
  } catch (err) {
    const error = err as Error;
    logger.error(`GET /research/profiles error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/profiles/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid profile id' });
    }
    const profile = await getProfileById(id);
    if (!profile) {
      return res.status(404).json({ error: `Profile not found: ${id}` });
    }
    res.json(profile);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/profiles', async (req, res) => {
  try {
    const body = req.body as Record<string, unknown>;
    if (!body.name || !body.config) {
      return res.status(400).json({ error: 'name and config are required' });
    }
    const profile = await createProfile({
      name: String(body.name),
      description: body.description ? String(body.description) : undefined,
      origin: (body.origin as any) || 'manual',
      strategy_type: body.strategy_type ? String(body.strategy_type) : undefined,
      market_mode: body.market_mode ? String(body.market_mode) : undefined,
      base_symbol: body.base_symbol ? String(body.base_symbol) : undefined,
      quote_symbol: body.quote_symbol ? String(body.quote_symbol) : undefined,
      interval: body.interval ? String(body.interval) : '1h',
      config: body.config as Record<string, unknown>,
      metrics: body.metrics as Record<string, unknown> | undefined,
      sweep_run_id: body.sweep_run_id ? Number(body.sweep_run_id) : undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    res.status(201).json(profile);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.patch('/profiles/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body as Record<string, unknown>;
    const updated = await updateProfile(id, {
      name: body.name ? String(body.name) : undefined,
      description: body.description !== undefined ? String(body.description) : undefined,
      config: body.config as Record<string, unknown> | undefined,
      metrics: body.metrics as Record<string, unknown> | undefined,
      tags: Array.isArray(body.tags) ? (body.tags as string[]) : undefined,
    });
    res.json(updated);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.delete('/profiles/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    await archiveProfile(id);
    res.json({ success: true, archived: id });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ── Publish Gate ───────────────────────────────────────────────────────────────

router.post('/profiles/:id/publish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body as { apiKeyName?: string; notes?: string };
    if (!body.apiKeyName) {
      return res.status(400).json({ error: 'apiKeyName is required' });
    }
    const result = await publishProfileToRuntime(id, {
      apiKeyName: body.apiKeyName,
      publishedBy: 'admin',
      notes: body.notes,
    });
    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_publish_profile', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify({ profileId: id, apiKeyName: body.apiKeyName, notes: body.notes || '' })]
    );
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    logger.error(`Publish profile #${req.params.id} error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.delete('/profiles/:id/publish', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const body = req.body as { notes?: string };
    await revokePublishedProfile(id, { publishedBy: 'admin', notes: body?.notes });
    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_revoke_profile', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify({ profileId: id, notes: body?.notes || '' })]
    );
    res.json({ success: true, revoked: id });
  } catch (err) {
    const error = err as Error;
    logger.error(`Revoke profile #${req.params.id} error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

// ── Preview ────────────────────────────────────────────────────────────────────

router.post('/profiles/:id/preview', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const profile = await getProfileById(id);
    if (!profile) {
      return res.status(404).json({ error: `Profile not found: ${id}` });
    }
    let config: Record<string, unknown> = {};
    try {
      config = JSON.parse(profile.config_json) as Record<string, unknown>;
    } catch { /* empty */ }

    const job = await enqueuePreviewJob(config, { profile_id: id, priority: 5 });
    res.json(job);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/profiles/:id/preview', async (req, res) => {
  try {
    const id = Number(req.params.id);
    // Find last preview job for this profile
    const { getResearchDb } = await import('../research/db');
    const db = getResearchDb();
    const job = await db.get(
      `SELECT * FROM preview_jobs WHERE profile_id = ? ORDER BY created_at DESC LIMIT 1`,
      [id]
    );
    if (!job) {
      return res.json({ status: 'none' });
    }
    const result = (job.result_json as string | null) ? JSON.parse(job.result_json as string) : null;
    res.json({ status: job.status, jobId: Number(job.id), result, error: job.error });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ── Ad-hoc preview ─────────────────────────────────────────────────────────────

router.post('/preview', async (req, res) => {
  try {
    const config = req.body?.config as Record<string, unknown>;
    if (!config || typeof config !== 'object') {
      return res.status(400).json({ error: 'config object is required in request body' });
    }
    const priority = Number(req.body?.priority ?? 10);
    const job = await enqueuePreviewJob(config, { priority });
    res.json(job);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/preview/:jobId', async (req, res) => {
  try {
    const jobId = Number(req.params.jobId);
    const job = await getPreviewJob(jobId);
    if (!job) {
      return res.status(404).json({ error: `Preview job not found: ${jobId}` });
    }
    const result = await getPreviewResult(jobId);
    res.json({ ...job, result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// SWEEP RUNS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/sweeps', async (req, res) => {
  try {
    const { getResearchDb } = await import('../research/db');
    const db = getResearchDb();
    const rows = await db.all(
      `SELECT id, name, description, status, result_summary_json, artifact_file_path, catalog_file_path, started_at, completed_at, created_at
       FROM sweep_runs ORDER BY created_at DESC LIMIT 50`
    );
    res.json(rows || []);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/sweeps/:id', async (req, res) => {
  try {
    const id = Number(req.params.id);
    const { getResearchDb } = await import('../research/db');
    const db = getResearchDb();
    const sweep = await db.get('SELECT * FROM sweep_runs WHERE id = ?', [id]);
    if (!sweep) {
      return res.status(404).json({ error: `Sweep not found: ${id}` });
    }
    const artifacts = await db.all('SELECT * FROM sweep_artifacts WHERE sweep_run_id = ?', [id]);
    res.json({ sweep, artifacts: artifacts || [] });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/sweeps/:id/pairs', async (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isFinite(id) || id <= 0) {
      return res.status(400).json({ error: 'Invalid sweep id' });
    }
    const pairs = await listSweepPairs(id);
    res.json({ sweepRunId: id, pairs });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/sweeps/full-historical/start', async (req, res) => {
  try {
    const result = await startHistoricalSweepJob({
      mode: parseSweepRunMode(req.body?.mode),
      apiKeyName: req.body?.apiKeyName ? String(req.body.apiKeyName) : undefined,
      dateFrom: req.body?.dateFrom ? String(req.body.dateFrom) : undefined,
      dateTo: req.body?.dateTo ? String(req.body.dateTo) : undefined,
      interval: req.body?.interval ? String(req.body.interval) : undefined,
      intervals: req.body?.intervals,
      strategyTypes: req.body?.strategyTypes,
      monoMarkets: req.body?.monoMarkets,
      synthMarkets: req.body?.synthMarkets,
      ddLengths: req.body?.ddLengths,
      ddTakeProfits: req.body?.ddTakeProfits,
      ddSources: req.body?.ddSources,
      statLengths: req.body?.statLengths,
      statEntry: req.body?.statEntry,
      statExit: req.body?.statExit,
      statStop: req.body?.statStop,
      maxRuns: req.body?.maxRuns ? Number(req.body.maxRuns) : undefined,
      maxVariantsPerMarketType: req.body?.maxVariantsPerMarketType ? Number(req.body.maxVariantsPerMarketType) : undefined,
      backtestBars: req.body?.backtestBars ? Number(req.body.backtestBars) : undefined,
      warmupBars: req.body?.warmupBars ? Number(req.body.warmupBars) : undefined,
      initialBalance: req.body?.initialBalance ? Number(req.body.initialBalance) : undefined,
      commissionPercent: req.body?.commissionPercent ? Number(req.body.commissionPercent) : undefined,
      slippagePercent: req.body?.slippagePercent ? Number(req.body.slippagePercent) : undefined,
      fundingRatePercent: req.body?.fundingRatePercent != null ? Number(req.body.fundingRatePercent) : undefined,
      skipMissingSymbols: req.body?.skipMissingSymbols,
      exhaustiveMode: req.body?.exhaustiveMode,
      turboMode: req.body?.turboMode,
      resumeEnabled: req.body?.resumeEnabled,
      checkpointFile: req.body?.checkpointFile ? String(req.body.checkpointFile) : undefined,
      robust: req.body?.robust,
      updateExistingStrategies: req.body?.updateExistingStrategies,
      windowBacktestsEnabled: req.body?.windowBacktestsEnabled,
      allowDuplicateMarkets: req.body?.allowDuplicateMarkets,
      maxMembers: req.body?.maxMembers ? Number(req.body.maxMembers) : undefined,
      systemName: req.body?.systemName ? String(req.body.systemName) : undefined,
      strategyPrefix: req.body?.strategyPrefix ? String(req.body.strategyPrefix) : undefined,
      checkpointEvery: req.body?.checkpointEvery ? Number(req.body.checkpointEvery) : undefined,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    logger.error(`POST /research/sweeps/full-historical/start error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.get('/sweeps/full-historical/status', async (_req, res) => {
  try {
    const result = await getHistoricalSweepStatus();
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    logger.error(`GET /research/sweeps/full-historical/status error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

router.post('/sweeps/full-historical/abort', async (req, res) => {
  try {
    const reason = req.body?.reason ? String(req.body.reason) : 'aborted by operator';
    const result = await abortHistoricalSweepJob(reason);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    logger.error(`POST /research/sweeps/full-historical/abort error: ${error.message}`);
    res.status(500).json({ error: error.message });
  }
});

/**
 * Register a sweep run from an existing JSON file on the VPS filesystem.
 * Does NOT start a new sweep — that is done via the existing scripts.
 */
router.post('/sweeps/register', async (req, res) => {
  try {
    const body = req.body as {
      name?: string;
      description?: string;
      artifactFilePath?: string;
      catalogFilePath?: string;
      resultSummary?: Record<string, unknown>;
    };
    if (!body.name) {
      return res.status(400).json({ error: 'name is required' });
    }
    const id = await registerSweepRun({
      name: body.name,
      description: body.description,
      artifactFilePath: body.artifactFilePath,
      catalogFilePath: body.catalogFilePath,
      resultSummary: body.resultSummary,
    });
    res.status(201).json({ id, success: true });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/** Import sweep candidates from a catalog JSON into strategy_profiles. */
router.post('/sweeps/:id/import-candidates', async (req, res) => {
  try {
    const sweepRunId = Number(req.params.id);
    const candidates = req.body?.candidates;

    // If candidates provided in body — use them directly
    if (Array.isArray(candidates)) {
      const result = await importSweepCandidates(sweepRunId, candidates);
      return res.json(result);
    }

    // Otherwise read from the sweep's registered catalog_file_path
    const { getResearchDb } = await import('../research/db');
    const rdb = getResearchDb();
    const sweep = await rdb.get('SELECT * FROM sweep_runs WHERE id = ?', [sweepRunId]) as { catalog_file_path?: string | null } | undefined;
    if (!sweep) {
      return res.status(404).json({ error: `Sweep not found: ${sweepRunId}` });
    }
    if (!sweep.catalog_file_path) {
      return res.status(400).json({
        error: 'Sweep has no catalog_file_path. Use "Import artifacts" button or provide a candidates array.',
      });
    }

    const result = await importCandidatesFromSweepCatalog(sweepRunId, sweep.catalog_file_path);
    res.json(result);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/**
 * Manual one-shot import of existing historical artifacts into research.db.
 * Useful for bootstrapping Phase 2 from already generated JSON files.
 */
router.post('/sweeps/import-from-file', async (req, res) => {
  try {
    const body = req.body as {
      catalogFilePath?: string;
      sweepFilePath?: string;
      sweepName?: string;
      description?: string;
    };

    if (!body.catalogFilePath) {
      return res.status(400).json({ error: 'catalogFilePath is required' });
    }

    const result = await importHistoricalArtifactsToResearch({
      catalogFilePath: body.catalogFilePath,
      sweepFilePath: body.sweepFilePath,
      sweepName: body.sweepName,
      description: body.description,
    });
    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_import_artifacts', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify({ catalogFilePath: body.catalogFilePath, sweepFilePath: body.sweepFilePath || null, sweepName: body.sweepName || null, imported: result.imported, skipped: result.skipped })]
    );
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASKS FROM CLIENT REQUESTS
// ═══════════════════════════════════════════════════════════════════════════════

router.post('/tasks/backtest-requests/sync', async (_req, res) => {
  try {
    const result = await syncClientBacktestRequestsToResearchTasks();
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/tasks/backtest-requests', async (req, res) => {
  try {
    const status = String(req.query.status || '').trim();
    const onlySelected = String(req.query.onlySelected || '').trim() === '1';
    const tasks = await listResearchSweepTasks({
      status: status ? (status as any) : undefined,
      onlySelected,
      limit: req.query.limit ? Number(req.query.limit) : undefined,
    });
    res.json({ tasks });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.patch('/tasks/backtest-requests/selection', async (req, res) => {
  try {
    const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.map((id: unknown) => Number(id)) : [];
    const isSelected = Boolean(req.body?.isSelected);
    const result = await setResearchSweepTaskSelection(taskIds, isSelected);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.patch('/tasks/backtest-requests/mark', async (req, res) => {
  try {
    const taskIds = Array.isArray(req.body?.taskIds) ? req.body.taskIds.map((id: unknown) => Number(id)) : [];
    const status = String(req.body?.status || '').trim() as 'done' | 'ignored' | 'new';
    if (!['done', 'ignored', 'new'].includes(status)) {
      return res.status(400).json({ error: 'status must be one of: done | ignored | new' });
    }
    const result = await markResearchSweepTasks(taskIds, status);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks/run-sweep', async (req, res) => {
  try {
    const result = await runSweepFromSelectedTasks({
      taskIds: Array.isArray(req.body?.taskIds) ? req.body.taskIds.map((id: unknown) => Number(id)) : undefined,
      dateFrom: req.body?.dateFrom ? String(req.body.dateFrom) : undefined,
      dateTo: req.body?.dateTo ? String(req.body.dateTo) : undefined,
      interval: req.body?.interval ? String(req.body.interval) : undefined,
      markDone: req.body?.markDone !== false,
      mode: parseSweepRunMode(req.body?.mode),
    });

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_run_sweep_from_tasks', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(result)]
    );

    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks/run-sweep/manual', async (req, res) => {
  try {
    const result = await runSweepFromManualMarkets({
      markets: Array.isArray(req.body?.markets)
        ? req.body.markets.map((item: unknown) => String(item))
        : (req.body?.markets ? String(req.body.markets).split(/[\n,;]+/) : []),
      dateFrom: req.body?.dateFrom ? String(req.body.dateFrom) : undefined,
      dateTo: req.body?.dateTo ? String(req.body.dateTo) : undefined,
      interval: req.body?.interval ? String(req.body.interval) : undefined,
      sweepName: req.body?.sweepName ? String(req.body.sweepName) : undefined,
      description: req.body?.description ? String(req.body.description) : undefined,
      note: req.body?.note ? String(req.body.note) : undefined,
      mode: parseSweepRunMode(req.body?.mode),
    });

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_run_sweep_manual_pairs', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(result)]
    );

    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/tasks/high-frequency-system', async (req, res) => {
  try {
    const apiKeyName = String(req.body?.apiKeyName || '').trim();
    if (!apiKeyName) {
      return res.status(400).json({ error: 'apiKeyName is required' });
    }

    const mode = parseSweepRunMode(req.body?.mode);
    const targetTradesPerDay = Math.max(1, Math.min(50, Number(req.body?.targetTradesPerDay || 10)));
    const maxMembers = Math.max(2, Math.min(12, Math.floor(Number(req.body?.maxMembers || 6))));
    const minPf = Math.max(0.5, Math.min(4, Number(req.body?.minPf || 1.05)));
    const maxDd = Math.max(5, Math.min(80, Number(req.body?.maxDd || 28)));

    const { sweep } = await loadCatalogAndSweepWithFallback();
    if (!sweep || !Array.isArray(sweep.evaluated) || sweep.evaluated.length === 0) {
      return res.status(400).json({ error: 'Sweep data is unavailable. Run historical sweep first.' });
    }

    const strategies = await getStrategies(apiKeyName, { includeLotPreview: false });
    const existingById = new Map<number, any>();
    for (const row of strategies) {
      const strategyId = Number(row.id || 0);
      if (strategyId > 0) {
        existingById.set(strategyId, row);
      }
    }

    const dateFromMs = Date.parse(String(sweep.config?.dateFrom || ''));
    const dateToMs = Date.parse(String(sweep.config?.dateTo || ''));
    const inferredDays = Number.isFinite(dateFromMs) && Number.isFinite(dateToMs) && dateToMs > dateFromMs
      ? Math.max(1, Math.floor((dateToMs - dateFromMs) / 86_400_000))
      : 365;
    const frequencyWindowDays = Math.max(7, Math.min(365, Math.floor(Number(req.body?.windowDays || inferredDays || 90))));

    const allCandidates = sweep.evaluated
      .map((item) => {
        const strategyId = Number(item.strategyId || 0);
        const strategy = existingById.get(strategyId) || null;
        const tradesCount = Math.max(0, Number(item.tradesCount || 0));
        const tradesPerDay = Number((tradesCount / frequencyWindowDays).toFixed(3));
        return {
          strategyId,
          strategy,
          strategyName: String(item.strategyName || strategy?.name || `#${strategyId}`),
          market: String(item.market || ''),
          marketMode: String(item.marketMode || ''),
          strategyType: String(item.strategyType || strategy?.strategy_type || ''),
          interval: String(item.interval || strategy?.interval || ''),
          profitFactor: Number(item.profitFactor || 0),
          maxDrawdownPercent: Number(item.maxDrawdownPercent || 0),
          totalReturnPercent: Number(item.totalReturnPercent || 0),
          score: Number(item.score || 0),
          tradesCount,
          tradesPerDay,
        };
      })
      .filter((item) => item.strategyId > 0 && item.strategy);

    const fallbackProfiles = [
      {
        label: 'A',
        targetTradesPerDay,
        minPf,
        maxDd,
      },
      {
        label: 'B',
        targetTradesPerDay: Math.min(targetTradesPerDay, 6),
        minPf: Math.max(0.9, Number((minPf - 0.03).toFixed(3))),
        maxDd: Math.min(80, Number((maxDd + 2).toFixed(3))),
      },
      {
        label: 'C',
        targetTradesPerDay: Math.min(targetTradesPerDay, 4),
        minPf: Math.max(0.85, Number((minPf - 0.05).toFixed(3))),
        maxDd: Math.min(80, Number((maxDd + 5).toFixed(3))),
      },
    ];

    const buildCandidates = (profile: { targetTradesPerDay: number; minPf: number; maxDd: number }) => allCandidates
      .filter((item) => item.profitFactor >= profile.minPf && item.maxDrawdownPercent <= profile.maxDd)
      .map((item) => ({
        ...item,
        distance: Math.abs(item.tradesPerDay - profile.targetTradesPerDay),
      }))
      .sort((left, right) => {
        if (left.distance !== right.distance) {
          return left.distance - right.distance;
        }
        if (left.tradesPerDay !== right.tradesPerDay) {
          return right.tradesPerDay - left.tradesPerDay;
        }
        return right.score - left.score;
      });

    let activeProfile = fallbackProfiles[0];
    let candidates = buildCandidates(activeProfile);
    if (candidates.length === 0) {
      for (const profile of fallbackProfiles.slice(1)) {
        const next = buildCandidates(profile);
        if (next.length > 0) {
          activeProfile = profile;
          candidates = next;
          break;
        }
      }
    }

    if (candidates.length === 0) {
      const historicalStatus = await getHistoricalSweepStatus().catch(() => null) as Record<string, any> | null;
      const processedRunsRaw = Number(historicalStatus?.details?.processedRuns || historicalStatus?.processed_days || 0);
      const totalRuns = Math.max(0, Number(historicalStatus?.details?.totalRuns || 0));
      const processedRuns = totalRuns > 0
        ? Math.min(totalRuns, Math.max(0, processedRunsRaw))
        : Math.max(0, processedRunsRaw);
      const progressPercent = totalRuns > 0
        ? Number(((processedRuns / totalRuns) * 100).toFixed(2))
        : Math.max(0, Math.min(100, Number(historicalStatus?.progress_percent || 0)));
      const shouldShowRunningHint = historicalStatus?.status === 'running' && (totalRuns <= 0 || processedRuns < totalRuns);
      const runningHint = shouldShowRunningHint
        ? ` Full historical sweep is still running: job #${historicalStatus?.id || 'n/a'} ${processedRuns}/${totalRuns} (${progressPercent}%). High-frequency TS generation uses completed sweep artifacts, not the in-progress job.`
        : '';
      const profileHint = ` Tried fallback ladder A/B/C with targets ${fallbackProfiles.map((item) => `${item.targetTradesPerDay}/day`).join(' -> ')} and PF/DD relaxation.`;
      const configHint = ' To reach ~10/day reliably, run dedicated HF sweep profile with shorter horizon (60-120 days) and faster intervals (15m/30m).';
      return res.status(400).json({ error: `No candidates match PF/DD filters in current sweep for this API key.${runningHint}${profileHint}${configHint}` });
    }

    const selected: typeof candidates = [];
    const selectedIds = new Set<number>();

    const preferredMono = candidates.find((item) => item.marketMode === 'mono');
    const preferredSynth = candidates.find((item) => item.marketMode !== 'mono');

    if (preferredMono) {
      selected.push(preferredMono);
      selectedIds.add(preferredMono.strategyId);
    }
    if (preferredSynth && !selectedIds.has(preferredSynth.strategyId)) {
      selected.push(preferredSynth);
      selectedIds.add(preferredSynth.strategyId);
    }

    for (const item of candidates) {
      if (selected.length >= maxMembers) {
        break;
      }
      if (selectedIds.has(item.strategyId)) {
        continue;
      }
      selected.push(item);
      selectedIds.add(item.strategyId);
    }

    const weight = Number((1 / Math.max(1, selected.length)).toFixed(4));
    const name = `HF ${mode.toUpperCase()} ${targetTradesPerDay}tpd ${new Date().toISOString().slice(0, 10)}`;
    const createdSystem = await createTradingSystem(apiKeyName, {
      name,
      description: `Auto-generated high-frequency system (${mode}) target ${targetTradesPerDay} trades/day`,
      is_active: false,
      auto_sync_members: true,
      discovery_enabled: false,
      max_members: Math.max(maxMembers, selected.length),
      members: selected.map((item, index) => ({
        strategy_id: item.strategyId,
        weight,
        member_role: index < 2 ? 'core' : 'satellite',
        is_enabled: true,
        notes: `hf_${mode}; tpd=${item.tradesPerDay}; pf=${item.profitFactor.toFixed(2)}; dd=${item.maxDrawdownPercent.toFixed(2)}`,
      })),
    });

    const bars = mode === 'heavy' ? 6000 : 1600;
    const preview = await runTradingSystemBacktest(apiKeyName, Number(createdSystem.id), {
      bars,
      warmupBars: mode === 'heavy' ? 400 : 120,
      initialBalance: 10000,
    });

    const payload = {
      apiKeyName,
      mode,
      targetTradesPerDay,
      inferredSweepDays: inferredDays,
      frequencyWindowDays,
      selectionProfile: {
        label: activeProfile.label,
        targetTradesPerDay: activeProfile.targetTradesPerDay,
        minPf: activeProfile.minPf,
        maxDd: activeProfile.maxDd,
      },
      selectedMembers: selected.map((item) => ({
        strategyId: item.strategyId,
        strategyName: item.strategyName,
        market: item.market,
        marketMode: item.marketMode,
        strategyType: item.strategyType,
        tradesPerDay: item.tradesPerDay,
        tradesCount: item.tradesCount,
        profitFactor: item.profitFactor,
        maxDrawdownPercent: item.maxDrawdownPercent,
        score: item.score,
      })),
      createdSystem,
      preview: {
        bars,
        summary: preview.summary,
      },
      candidateSample: candidates.slice(0, 15).map((item) => ({
        strategyId: item.strategyId,
        strategyName: item.strategyName,
        tradesPerDay: item.tradesPerDay,
        profitFactor: item.profitFactor,
        maxDrawdownPercent: item.maxDrawdownPercent,
        score: item.score,
      })),
    };

    await db.run(
      `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
       VALUES (NULL, 'platform_admin', 'research_generate_high_frequency_system', ?, CURRENT_TIMESTAMP)`,
      [JSON.stringify(payload)]
    );

    res.json({ success: true, ...payload });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// CLIENT PRESETS
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/presets', async (req, res) => {
  try {
    const offers = await listOfferIds();
    res.json(offers);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/presets/:offerId', async (req, res) => {
  try {
    const { offerId } = req.params;
    const risk = String(req.query.risk || 'medium') as any;
    const freq = String(req.query.freq || 'medium') as any;
    const preset = await getPreset(offerId, risk, freq);
    if (!preset) {
      return res.status(404).json({ error: `Preset not found for ${offerId} risk=${risk} freq=${freq}` });
    }
    res.json(preset);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

/** Build 9 presets for a given offer from a base config + metrics. */
router.post('/presets/:offerId/build', async (req, res) => {
  try {
    const { offerId } = req.params;
    const body = req.body as {
      config?: Record<string, unknown>;
      metrics?: Record<string, unknown>;
      equity_curve?: number[];
      sweep_run_id?: number;
    };
    if (!body.config || !body.metrics) {
      return res.status(400).json({ error: 'config and metrics are required' });
    }
    await buildPresetsForOffer(
      offerId,
      body.config,
      body.metrics,
      body.equity_curve ?? [],
      body.sweep_run_id ?? 0
    );
    res.json({ success: true, offerId });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// RESEARCH SCHEDULER + OBSERVABILITY
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/scheduler', async (_req, res) => {
  try {
    const jobs = await listSchedulerJobs();
    res.json({ jobs });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.patch('/scheduler/:jobKey', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const body = req.body as {
      isEnabled?: boolean;
      hourUtc?: number;
      minuteUtc?: number;
    };

    const updated = await updateSchedulerJob('daily_incremental_sweep', {
      is_enabled: body.isEnabled,
      hour_utc: body.hourUtc,
      minute_utc: body.minuteUtc,
    });

    res.json({ success: true, job: updated });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/scheduler/:jobKey/run-now', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const result = await runSchedulerJobNow('daily_incremental_sweep');
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/scheduler/:jobKey/gap', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const daysBack = req.query.daysBack ? Number(req.query.daysBack) : 30;
    const result = await analyzeDailySweepGap(daysBack);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/scheduler/:jobKey/backfill-now', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const maxDays = req.body?.maxDays ? Number(req.body.maxDays) : 30;
    const mode = parseSweepRunMode(req.body?.mode);
    const result = await runDailySweepGapBackfill(maxDays, mode);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.post('/scheduler/:jobKey/backfill-start', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const maxDays = req.body?.maxDays ? Number(req.body.maxDays) : 30;
    const mode = parseSweepRunMode(req.body?.mode);
    const result = await startDailySweepGapBackfillJob(maxDays, mode);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/scheduler/:jobKey/backfill-status', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const status = await getDailySweepBackfillStatus();
    res.json({ success: true, ...status });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.patch('/scheduler/:jobKey/backfill-mode', async (req, res) => {
  try {
    const jobKey = String(req.params.jobKey || '');
    if (jobKey !== 'daily_incremental_sweep') {
      return res.status(400).json({ error: `Unsupported scheduler job key: ${jobKey}` });
    }

    const mode = parseSweepRunMode(req.body?.mode);
    const result = await updateDailySweepBackfillMode(mode, req.body?.jobId);
    res.json({ success: true, ...result });
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

router.get('/observability/db', async (_req, res) => {
  try {
    const data = await getResearchDbObservability();
    res.json(data);
  } catch (err) {
    const error = err as Error;
    res.status(500).json({ error: error.message });
  }
});

export default router;

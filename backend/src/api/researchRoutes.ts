/**
 * Research circuit API routes: /api/research/*
 *
 * Admin-only. All routes require the standard admin Bearer token.
 * Research DB is initialized lazily on first request.
 */
import { Router } from 'express';
import { authenticate } from '../utils/auth';
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
import logger from '../utils/logger';

const router = Router();

// ── Ensure research DB is ready on every request ──────────────────────────────
router.use(async (_req, _res, next) => {
  try {
    await initResearchDb();
    next();
  } catch (err) {
    next(err);
  }
});

// ── All research routes require admin auth ─────────────────────────────────────
router.use(authenticate);

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
    if (!Array.isArray(candidates)) {
      return res.status(400).json({ error: 'candidates array is required' });
    }
    const result = await importSweepCandidates(sweepRunId, candidates);
    res.json(result);
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

export default router;

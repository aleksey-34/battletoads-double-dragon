// ─── Razgon API Routes ───────────────────────────────────────────────────────
import { Router, Request, Response } from 'express';
import {
  startRazgon,
  stopRazgon,
  pauseRazgon,
  getRazgonStatus,
  getRazgonConfig,
  getTradeHistory,
  updateRazgonConfig,
} from './razgonEngine';
import { DEFAULT_RAZGON_CONFIG } from './razgonTypes';
import type { RazgonConfig } from './razgonTypes';
import logger from '../utils/logger';

const router = Router();

// GET /api/razgon/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(getRazgonStatus());
});

// GET /api/razgon/config
router.get('/config', (_req: Request, res: Response) => {
  const cfg = getRazgonConfig();
  res.json(cfg ?? DEFAULT_RAZGON_CONFIG);
});

// PATCH /api/razgon/config
router.patch('/config', (req: Request, res: Response) => {
  const patch = req.body as Partial<RazgonConfig>;
  updateRazgonConfig(patch);
  res.json({ ok: true, config: getRazgonConfig() });
});

// POST /api/razgon/start
router.post('/start', async (req: Request, res: Response) => {
  const cfg: RazgonConfig = {
    ...DEFAULT_RAZGON_CONFIG,
    ...(req.body || {}),
  };

  // Validate required fields
  if (!cfg.apiKeyName) {
    res.status(400).json({ ok: false, error: 'apiKeyName is required' });
    return;
  }

  const result = await startRazgon(cfg);
  if (!result.ok) {
    res.status(400).json(result);
    return;
  }
  res.json(result);
});

// POST /api/razgon/stop
router.post('/stop', async (_req: Request, res: Response) => {
  await stopRazgon();
  res.json({ ok: true });
});

// POST /api/razgon/pause
router.post('/pause', async (_req: Request, res: Response) => {
  await pauseRazgon();
  res.json({ ok: true });
});

// GET /api/razgon/trades
router.get('/trades', (req: Request, res: Response) => {
  const limit = Math.min(Number(req.query.limit) || 100, 1000);
  res.json(getTradeHistory(limit));
});

export default router;

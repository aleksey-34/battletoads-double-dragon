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
  refreshRazgonLive,
  getRazgonKeyBalances,
} from './razgonEngine';
import { DEFAULT_RAZGON_CONFIG } from './razgonTypes';
import type { RazgonConfig } from './razgonTypes';
import logger from '../utils/logger';

const router = Router();

// GET /api/razgon/status
router.get('/status', (_req: Request, res: Response) => {
  res.json(getRazgonStatus());
});

// POST /api/razgon/refresh — live refresh from exchange
router.post('/refresh', async (_req: Request, res: Response) => {
  try {
    const data = await refreshRazgonLive();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
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

// GET /api/razgon/key-balances — fetch live balance for each configured api key
router.get('/key-balances', async (_req: Request, res: Response) => {
  try {
    const data = await getRazgonKeyBalances();
    res.json(data);
  } catch (e) {
    res.status(500).json({ error: (e as Error).message });
  }
});

// POST /api/razgon/key-toggle — enable/disable a key (body: { name, enabled })
router.post('/key-toggle', (req: Request, res: Response) => {
  const { name, enabled } = req.body as { name: string; enabled: boolean };
  const cfg = getRazgonConfig();
  if (!cfg) { res.status(400).json({ error: 'Engine not configured' }); return; }
  const key = cfg.apiKeys?.find(k => k.name === name);
  if (!key) { res.status(404).json({ error: `Key ${name} not found` }); return; }
  key.enabled = enabled;
  updateRazgonConfig({ apiKeys: cfg.apiKeys });
  res.json({ ok: true });
});

export default router;

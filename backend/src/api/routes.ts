import fs from 'fs';
import path from 'path';
import { Router } from 'express';
import {
  getPasswordRecoveryStatus,
  PasswordRecoveryError,
  requestPasswordRecoveryCode,
  resetPasswordWithRecoveryCode,
} from '../system/passwordRecovery';
import tvAlertsRoutes from './tvAlertsRoutes';
import analyticsRoutes from './analyticsRoutes';
import saasRoutes from './saasRoutes';
import clientRoutes from './routes/clientRoutes';
import backtestRoutes from './routes/backtestRoutes';
import adminRoutes from './routes/adminRoutes';
import { getMonitoringBundle } from '../bot/monitoring';
import { db } from '../utils/database';
import logger from '../utils/logger';

const router = Router();

const landingDemoPath = path.resolve(__dirname, '../../../docs/landing-demo-trades.json');
const PUBLIC_PORTFOLIO_CACHE_TTL_MS = 3_600_000;
const publicPortfolioCache = new Map<string, { expiresAt: number; payload: unknown }>();

// Legacy hard-stubs: Razgon and Synctrade APIs were removed.
router.use('/razgon', (_req, res) => {
  return res.status(404).json({ error: 'Not Found' });
});

router.use('/saas/synctrade', (_req, res) => {
  return res.status(404).json({ error: 'Not Found' });
});

router.get('/public/landing-demo-trades', (_req, res) => {
  try {
    if (!fs.existsSync(landingDemoPath)) {
      return res.status(404).json({ error: 'Landing demo not generated' });
    }
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.type('json').send(fs.readFileSync(landingDemoPath, 'utf8'));
  } catch (error) {
    const err = error as Error;
    logger.error(`landing-demo-trades: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.get('/public/portfolio/:slug', async (req, res) => {
  try {
    const slug = String(req.params.slug || '').trim().toLowerCase();
    if (!slug) {
      return res.status(400).json({ error: 'slug required' });
    }

    const daysRaw = Number.parseInt(String(req.query.days || '0'), 10);
    const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 0;
    const allPeriod = String(req.query.all || '0') === '1'
      || String(req.query.all || '').toLowerCase() === 'true';
    const cacheKey = `${slug}|days=${days}|all=${allPeriod ? 1 : 0}`;
    const now = Date.now();
    const cached = publicPortfolioCache.get(cacheKey);
    if (cached && cached.expiresAt > now) {
      res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=300');
      return res.json(cached.payload);
    }

    const tenant = await db.get(
      `SELECT
         t.id,
         t.slug,
         t.display_name,
         t.product_mode,
         COALESCE(
           NULLIF(ap.execution_api_key_name, ''),
           NULLIF(ap.assigned_api_key_name, ''),
           NULLIF(sp.assigned_api_key_name, ''),
           NULLIF(t.assigned_api_key_name, ''),
           ''
         ) AS api_key_name,
         COALESCE(ap.published_system_name, '') AS published_system_name
       FROM tenants t
       LEFT JOIN algofund_profiles ap ON ap.tenant_id = t.id
       LEFT JOIN strategy_client_profiles sp ON sp.tenant_id = t.id
       WHERE LOWER(t.slug) = ?
         AND t.status != 'deleted'
       LIMIT 1`,
      [slug],
    ) as {
      id?: number;
      slug?: string;
      display_name?: string;
      product_mode?: string;
      api_key_name?: string;
      published_system_name?: string;
    } | undefined;

    if (!tenant) {
      return res.status(404).json({ error: 'Portfolio not found' });
    }

    const apiKeyName = String(tenant.api_key_name || '').trim();
    if (!apiKeyName) {
      return res.status(404).json({ error: 'Portfolio has no linked API key' });
    }

    const monitoring = await getMonitoringBundle(apiKeyName, {
      days,
      all: allPeriod,
      limit: days > 1 ? 5000 : 288,
      includeTrades: true,
      includeTradesRows: true,
      includeTradeMarkers: false,
    });

    const payload = {
      success: true,
      generatedAt: new Date().toISOString(),
      cacheTtlSec: Math.floor(PUBLIC_PORTFOLIO_CACHE_TTL_MS / 1000),
      portfolio: {
        slug: String(tenant.slug || slug),
        displayName: String(tenant.display_name || slug),
        productMode: String(tenant.product_mode || ''),
        publishedSystemName: String(tenant.published_system_name || ''),
        apiKeyName,
      },
      ...monitoring,
    };

    publicPortfolioCache.set(cacheKey, {
      expiresAt: now + PUBLIC_PORTFOLIO_CACHE_TTL_MS,
      payload,
    });

    res.setHeader('Cache-Control', 'public, max-age=3600, stale-while-revalidate=300');
    res.json(payload);
  } catch (error) {
    const err = error as Error;
    logger.error(`public-portfolio: ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

router.use(tvAlertsRoutes);

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

router.use(clientRoutes);
router.use('/saas', saasRoutes);
router.use('/analytics', analyticsRoutes);
router.use('/backtest', backtestRoutes);
router.use(adminRoutes);

export default router;

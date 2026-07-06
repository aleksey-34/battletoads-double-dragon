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
import logger from '../utils/logger';

const router = Router();

// Legacy hard-stubs: Razgon and Synctrade APIs were removed.
router.use('/razgon', (_req, res) => {
  return res.status(404).json({ error: 'Not Found' });
});

router.use('/saas/synctrade', (_req, res) => {
  return res.status(404).json({ error: 'Not Found' });
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

import express from 'express';
import cors from 'cors';
import routes from './api/routes';
import { initDB } from './utils/database';
import logger from './utils/logger';
import { runAutoStrategiesCycle } from './bot/strategy';

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json());
app.use('/api', routes);

import { loadSettings } from './config/settings';
import { initExchangeClient } from './bot/exchange';

const startServer = async () => {
  await initDB();
  logger.info('Database initialized');

  // Инициализация клиентов Bybit для всех ключей
  try {
    const { apiKeys } = await loadSettings();
    apiKeys.forEach((key: any) => {
      try {
        initExchangeClient(key);
      } catch (e) {
        logger.error(`Error initializing client for key ${key.name}: ${(e as Error).message}`);
      }
    });
  } catch (e) {
    logger.error('Error initializing exchange clients: ' + (e as Error).message);
  }

  app.listen(PORT, () => {
    logger.info(`Server running on http://localhost:${PORT}`);
  });

  const autoRunSecRaw = Number(process.env.STRATEGY_AUTORUN_SEC || 30);
  const autoRunSec = Number.isFinite(autoRunSecRaw) && autoRunSecRaw >= 5 ? Math.floor(autoRunSecRaw) : 30;
  let autoCycleRunning = false;

  setInterval(async () => {
    if (autoCycleRunning) {
      return;
    }

    autoCycleRunning = true;
    try {
      const result = await runAutoStrategiesCycle();
      if (result.total > 0) {
        logger.info(
          `Auto strategy cycle: total=${result.total}, processed=${result.processed}, failed=${result.failed}`
        );
      }
    } catch (error) {
      logger.error(`Auto strategy cycle error: ${(error as Error).message}`);
    } finally {
      autoCycleRunning = false;
    }
  }, autoRunSec * 1000);
};

startServer();

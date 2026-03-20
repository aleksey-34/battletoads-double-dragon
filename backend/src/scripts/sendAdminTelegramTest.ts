import { initDB, getDbFilePath } from '../utils/database';
import logger from '../utils/logger';
import { runAdminTelegramReportNow } from '../notifications/adminTelegramReporter';

const main = async () => {
  await initDB();
  logger.info(`[tg-admin-test] Database initialized: ${getDbFilePath()}`);

  await runAdminTelegramReportNow({
    includeLoginAlerts: false,
  });

  logger.info('[tg-admin-test] Test report sent');
};

main().catch((error) => {
  logger.error('[tg-admin-test] Failed: ' + (error as Error).message);
  process.exit(1);
});

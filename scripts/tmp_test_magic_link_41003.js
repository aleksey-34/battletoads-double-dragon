const { initDB } = require('../backend/dist/utils/database');
const { createClientMagicLink } = require('../backend/dist/utils/auth');

(async () => {
  await initDB();
  const result = await createClientMagicLink(41003, { ip: '127.0.0.1', userAgent: 'ops-check' }, 'ops_check_after_fix');
  console.log(JSON.stringify({
    tenantId: result.tenantId,
    userId: result.userId,
    hasUrl: Boolean(result.loginUrl),
    expiresAt: result.expiresAt,
  }, null, 2));
})().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});

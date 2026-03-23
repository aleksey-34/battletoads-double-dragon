const database = require('../backend/dist/utils/database');
const { initResearchDb } = require('../backend/dist/research/db');
const { retryMaterializeAlgofundSystem } = require('../backend/dist/saas/service');

(async () => {
  await database.initDB();
  await initResearchDb();

  const tenantId = 1288;
  const state = await retryMaterializeAlgofundSystem(tenantId);

  console.log(JSON.stringify({
    tenantId,
    requested_enabled: Number(state?.profile?.requested_enabled || 0),
    actual_enabled: Number(state?.profile?.actual_enabled || 0),
    sourceSystem: state?.preview?.sourceSystem?.systemName || null,
    blockedReason: state?.preview?.blockedReason || null,
  }, null, 2));
})().catch((error) => {
  console.error(String(error && error.message ? error.message : error));
  process.exit(1);
});

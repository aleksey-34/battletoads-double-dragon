import { initDB } from '../utils/database';
import { getHighTradeRecommendations } from '../saas/service';

const main = async () => {
  await initDB();
  const data = await getHighTradeRecommendations({
    minProfitFactor: Number(process.env.MIN_PF || 1.02),
    maxDrawdownPercent: Number(process.env.MAX_DD || 28),
    minReturnPercent: Number(process.env.MIN_RET || 3),
    limit: Number(process.env.LIMIT || 8),
  });

  console.log(JSON.stringify(data, null, 2));
};

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
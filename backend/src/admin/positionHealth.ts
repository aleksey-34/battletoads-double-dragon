import { getPositions, ensureExchangeClientInitialized } from '../bot/exchange';
import { db } from '../utils/database';

const normalizeKey = (raw: string): string => {
  const token = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!token) return '';
  return token.endsWith('USDT') ? token : `${token}USDT`;
};

export type PositionHealthRow = {
  slug: string;
  apiKey: string;
  mop: number;
  dbOpen: number;
  exchangeOpen: number;
  orphans: string[];
  ghosts: string[];
  problems: string[];
};

export type PositionHealthSummary = {
  checkedAt: string;
  clientsChecked: number;
  okCount: number;
  issueCount: number;
  apiErrors: number;
  issues: PositionHealthRow[];
};

const checkClientPositionHealth = async (row: {
  slug: string;
  ts_id: number;
  mop: number;
  api_key: string;
}): Promise<{ ok: boolean; apiError: boolean; issue?: PositionHealthRow }> => {
  const mop = Number(row.mop || 0);
  const dbOpenRows = await db.all(
    `SELECT s.base_symbol, s.state FROM trading_system_members tsm
     JOIN strategies s ON s.id = tsm.strategy_id
     WHERE tsm.system_id = ? AND tsm.is_enabled = 1 AND s.is_active = 1
       AND s.state != 'flat' AND COALESCE(s.strategy_type,'') NOT IN ('dca','dca_futures')`,
    [row.ts_id],
  ) as Array<{ base_symbol: string; state: string }>;
  const owned = new Set(dbOpenRows.map((s) => normalizeKey(s.base_symbol)).filter(Boolean));

  let exchangeKeys: string[] = [];
  try {
    await ensureExchangeClientInitialized(row.api_key);
    const positions = await getPositions(row.api_key);
    exchangeKeys = [
      ...new Set(
        (positions || [])
          .filter((p) => Math.abs(Number(p?.size || 0)) > 0)
          .map((p) => normalizeKey(String(p.symbol || '')))
          .filter(Boolean),
      ),
    ];
  } catch {
    return { ok: false, apiError: true };
  }

  const orphans = exchangeKeys.filter((sym) => !owned.has(sym));
  const ghosts = [...owned].filter((sym) => !exchangeKeys.includes(sym));
  const problems: string[] = [];
  if (dbOpenRows.length > mop) problems.push(`db>${mop}`);
  if (exchangeKeys.length > mop) problems.push(`exch>${mop}`);
  if (orphans.length) problems.push(`orphan:${orphans.join(',')}`);
  if (ghosts.length) problems.push(`ghost:${ghosts.join(',')}`);

  if (problems.length === 0) {
    return { ok: true, apiError: false };
  }

  return {
    ok: false,
    apiError: false,
    issue: {
      slug: row.slug,
      apiKey: row.api_key,
      mop,
      dbOpen: dbOpenRows.length,
      exchangeOpen: exchangeKeys.length,
      orphans,
      ghosts,
      problems,
    },
  };
};

const mapWithConcurrency = async <T, R>(
  items: T[],
  concurrency: number,
  mapper: (item: T) => Promise<R>,
): Promise<R[]> => {
  if (items.length === 0) {
    return [];
  }
  const safeConcurrency = Math.max(1, Math.min(concurrency, items.length));
  const results = new Array<R>(items.length);
  let nextIndex = 0;

  const worker = async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await mapper(items[current]);
    }
  };

  await Promise.all(Array.from({ length: safeConcurrency }, () => worker()));
  return results;
};

export const getAlgofundPositionHealthSummary = async (): Promise<PositionHealthSummary> => {
  const rows = await db.all(`
    SELECT t.slug,
           ts.id AS ts_id,
           ts.max_open_positions AS mop,
           COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name) AS api_key
    FROM algofund_profiles ap
    JOIN tenants t ON t.id = ap.tenant_id
    JOIN api_keys ak ON ak.name = COALESCE(NULLIF(ap.execution_api_key_name,''), ap.assigned_api_key_name, t.assigned_api_key_name)
    JOIN trading_systems ts ON ts.api_key_id = ak.id AND ts.name = 'ALGOFUND::' || t.slug AND ts.is_active = 1
    WHERE ap.requested_enabled = 1 AND ap.actual_enabled = 1
    ORDER BY t.slug
  `) as Array<{ slug: string; ts_id: number; mop: number; api_key: string }>;

  const checked = await mapWithConcurrency(rows, 6, (row) => checkClientPositionHealth(row));
  const issues: PositionHealthRow[] = [];
  let okCount = 0;
  let apiErrors = 0;

  for (const result of checked) {
    if (result.apiError) {
      apiErrors += 1;
      continue;
    }
    if (result.ok) {
      okCount += 1;
      continue;
    }
    if (result.issue) {
      issues.push(result.issue);
    }
  }

  return {
    checkedAt: new Date().toISOString(),
    clientsChecked: rows.length,
    okCount,
    issueCount: issues.length,
    apiErrors,
    issues,
  };
};

import {
  PortfolioCircuitBreakerConfig,
  PortfolioCircuitBreakerState,
  PortfolioCircuitBreakerTracker,
  parsePortfolioCircuitBreaker,
} from '../services/portfolioCircuitBreaker';
import { db } from '../utils/database';

type RuntimeEntry = {
  tracker: PortfolioCircuitBreakerTracker;
  configKey: string;
  lastEquity: number;
  lastUpdateMs: number;
};

const runtimeByApiKey = new Map<string, RuntimeEntry>();

const stateFlagKey = (apiKeyName: string): string => (
  `portfolio_cb_state:${String(apiKeyName || '').trim()}`
);

const configCache = new Map<string, { config: PortfolioCircuitBreakerConfig | null; loadedAt: number }>();
const CONFIG_TTL_MS = 60_000;

const loadPublishedSystemName = async (apiKeyName: string): Promise<string> => {
  const row = await db.get<{ published_system_name?: string }>(
    `SELECT published_system_name FROM algofund_profiles
     WHERE COALESCE(execution_api_key_name, assigned_api_key_name) = ?
     ORDER BY updated_at DESC LIMIT 1`,
    [apiKeyName],
  );
  return String(row?.published_system_name || '').trim();
};

const loadConfigFromMasterCard = async (systemName: string): Promise<PortfolioCircuitBreakerConfig | null> => {
  if (!systemName) {
    return null;
  }
  const code = `CARD::${systemName.toUpperCase()}`;
  try {
    const row = await db.get<{ metadata_json?: string }>(
      'SELECT metadata_json FROM master_cards WHERE code = ? AND is_active = 1',
      [code],
    );
    if (!row?.metadata_json) {
      return null;
    }
    const meta = JSON.parse(row.metadata_json) as Record<string, unknown>;
    return parsePortfolioCircuitBreaker(meta.portfolioCircuitBreaker);
  } catch {
    return null;
  }
};

const loadPersistedState = async (apiKeyName: string): Promise<PortfolioCircuitBreakerState | null> => {
  try {
    const row = await db.get<{ value?: string }>(
      'SELECT value FROM app_runtime_flags WHERE key = ?',
      [stateFlagKey(apiKeyName)],
    );
    if (!row?.value) {
      return null;
    }
    const parsed = JSON.parse(row.value) as PortfolioCircuitBreakerState;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

const persistState = async (apiKeyName: string, state: PortfolioCircuitBreakerState): Promise<void> => {
  try {
    await db.run(
      `INSERT INTO app_runtime_flags (key, value, updated_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`,
      [stateFlagKey(apiKeyName), JSON.stringify(state)],
    );
  } catch {
    // non-critical
  }
};

export const loadPortfolioCircuitBreakerConfigForApiKey = async (
  apiKeyName: string,
): Promise<PortfolioCircuitBreakerConfig | null> => {
  const key = String(apiKeyName || '').trim();
  if (!key) {
    return null;
  }
  const cached = configCache.get(key);
  const now = Date.now();
  if (cached && now - cached.loadedAt < CONFIG_TTL_MS) {
    return cached.config;
  }
  const systemName = await loadPublishedSystemName(key);
  const config = await loadConfigFromMasterCard(systemName);
  configCache.set(key, { config, loadedAt: now });
  return config;
};

const configFingerprint = (config: PortfolioCircuitBreakerConfig | null): string => (
  JSON.stringify(config || { enabled: false })
);

const getOrCreateTracker = async (
  apiKeyName: string,
  config: PortfolioCircuitBreakerConfig,
): Promise<PortfolioCircuitBreakerTracker | null> => {
  const key = String(apiKeyName || '').trim();
  const fp = configFingerprint(config);
  const existing = runtimeByApiKey.get(key);
  if (existing && existing.configKey === fp) {
    return existing.tracker;
  }
  const tracker = PortfolioCircuitBreakerTracker.tryCreate(config);
  if (!tracker) {
    runtimeByApiKey.delete(key);
    return null;
  }
  const persisted = await loadPersistedState(key);
  tracker.restoreState(persisted);
  runtimeByApiKey.set(key, {
    tracker,
    configKey: fp,
    lastEquity: 0,
    lastUpdateMs: 0,
  });
  return tracker;
};

/** Lot multiplier for new entries (1.0 = no cut). Optional strategyType enables tier-CB. */
export const resolvePortfolioCircuitBreakerLotMultiplier = async (
  apiKeyName: string,
  portfolioEquityUsd: number,
  strategyType?: string,
): Promise<number> => {
  const key = String(apiKeyName || '').trim();
  if (!key) {
    return 1;
  }
  const config = await loadPortfolioCircuitBreakerConfigForApiKey(key);
  if (!config || config.enabled === false) {
    return 1;
  }
  const tracker = await getOrCreateTracker(key, config);
  if (!tracker) {
    return 1;
  }
  const equity = Number.isFinite(portfolioEquityUsd) && portfolioEquityUsd > 0
    ? portfolioEquityUsd
    : 0;
  if (equity <= 0) {
    return 1;
  }
  const now = Date.now();
  const update = tracker.update(equity, now);
  const entry = runtimeByApiKey.get(key);
  if (entry) {
    entry.lastEquity = equity;
    entry.lastUpdateMs = now;
  }
  await persistState(key, tracker.exportState());
  const raw = update.lotMultiplier > 0 ? update.lotMultiplier : 1;
  return tracker.lotMultiplierForStrategyType(String(strategyType || ''), raw);
};

/** Called from monitoring loop to keep CB state warm between sparse entries. */
export const syncPortfolioCircuitBreakerEquity = async (
  apiKeyName: string,
  portfolioEquityUsd: number,
): Promise<void> => {
  await resolvePortfolioCircuitBreakerLotMultiplier(apiKeyName, portfolioEquityUsd);
};

export const invalidatePortfolioCircuitBreakerCache = (apiKeyName?: string): void => {
  if (apiKeyName) {
    const key = String(apiKeyName || '').trim();
    runtimeByApiKey.delete(key);
    configCache.delete(key);
    return;
  }
  runtimeByApiKey.clear();
  configCache.clear();
};

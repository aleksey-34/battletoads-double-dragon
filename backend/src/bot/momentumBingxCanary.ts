import { db } from '../utils/database';
import logger from '../utils/logger';
import { notifyAdminUrgent } from '../notifications/adminTelegramReporter';

const CANARY_FLAG_KEY = 'runtime.momentum_bingx_canary';
const DEFAULT_CANARY_API_KEY = 'HDB_15';

type CanaryConfig = {
  enabled: boolean;
  apiKeyName: string;
  armedAt: string;
  triggeredAt?: string;
  lastSource?: string;
};

type CanaryEntryContext = {
  apiKeyName: string;
  strategyId: number;
  baseSymbol: string;
  signal: 'long' | 'short';
  currentRatio: number;
};

const resolveCanaryApiKey = (): string =>
  String(process.env.MOMENTUM_BINGX_CANARY_API_KEY || DEFAULT_CANARY_API_KEY).trim() || DEFAULT_CANARY_API_KEY;

const parseCanaryConfig = (raw: string | null | undefined): CanaryConfig | null => {
  const text = String(raw || '').trim();
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as Partial<CanaryConfig>;
    if (!parsed || parsed.enabled !== true) return null;
    return {
      enabled: true,
      apiKeyName: String(parsed.apiKeyName || resolveCanaryApiKey()).trim() || resolveCanaryApiKey(),
      armedAt: String(parsed.armedAt || ''),
      triggeredAt: parsed.triggeredAt ? String(parsed.triggeredAt) : undefined,
      lastSource: parsed.lastSource ? String(parsed.lastSource) : undefined,
    };
  } catch {
    return null;
  }
};

export const loadMomentumBingxCanary = async (): Promise<CanaryConfig | null> => {
  const row = await db.get('SELECT value FROM app_runtime_flags WHERE key = ?', [CANARY_FLAG_KEY]);
  return parseCanaryConfig(row?.value);
};

export const armMomentumBingxCanary = async (apiKeyName?: string): Promise<CanaryConfig> => {
  const config: CanaryConfig = {
    enabled: true,
    apiKeyName: String(apiKeyName || resolveCanaryApiKey()).trim() || resolveCanaryApiKey(),
    armedAt: new Date().toISOString(),
  };
  await db.run(
    `INSERT INTO app_runtime_flags (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CANARY_FLAG_KEY, JSON.stringify(config)],
  );
  logger.info(`[momentum-canary] armed for ${config.apiKeyName} at ${config.armedAt}`);
  return config;
};

const disarmCanary = async (config: CanaryConfig, patch: Partial<CanaryConfig>): Promise<void> => {
  const next: CanaryConfig = { ...config, ...patch, enabled: false };
  await db.run(
    `INSERT INTO app_runtime_flags (key, value, updated_at)
     VALUES (?, ?, datetime('now'))
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    [CANARY_FLAG_KEY, JSON.stringify(next)],
  );
};

const findCanaryLeg = async (apiKeyName: string, baseSymbol: string): Promise<{ id: number; state: string } | null> => {
  const row = await db.get(
    `SELECT s.id, COALESCE(s.state, 'flat') AS state
     FROM strategies s
     JOIN api_keys a ON a.id = s.api_key_id
     WHERE a.name = ?
       AND COALESCE(s.strategy_type, '') = 'momentum_scalp_tv'
       AND COALESCE(s.is_active, 0) = 1
       AND COALESCE(s.auto_update, 0) = 1
       AND COALESCE(s.is_archived, 0) = 0
       AND UPPER(COALESCE(s.base_symbol, '')) = UPPER(?)
     ORDER BY s.id ASC
     LIMIT 1`,
    [apiKeyName, baseSymbol],
  ) as { id?: number; state?: string } | undefined;
  if (!row?.id) return null;
  return { id: Number(row.id), state: String(row.state || 'flat') };
};

const notifyCanary = async (text: string): Promise<void> => {
  try {
    await notifyAdminUrgent(text);
  } catch (error) {
    logger.warn(`[momentum-canary] telegram notify failed: ${(error as Error).message}`);
  }
};

export const handleMomentumBingxCanaryAfterEntry = async (ctx: CanaryEntryContext): Promise<void> => {
  const config = await loadMomentumBingxCanary();
  if (!config) return;

  const canaryKey = config.apiKeyName;
  const symbol = String(ctx.baseSymbol || '').trim().toUpperCase();
  if (!symbol) return;

  if (ctx.apiKeyName === canaryKey) {
    await disarmCanary(config, {
      triggeredAt: new Date().toISOString(),
      lastSource: `direct:${symbol}:${ctx.signal}`,
    });
    await notifyCanary(
      `🐤 <b>Momentum BingX canary OK</b>\n`
      + `Ключ: <b>${canaryKey}</b>\n`
      + `Символ: <b>${symbol}</b> · ${ctx.signal} @ ${ctx.currentRatio.toFixed(6)}\n`
      + `S#${ctx.strategyId} — первый fill после arm (${config.armedAt})`,
    );
    logger.info(`[momentum-canary] direct fill on ${canaryKey} ${symbol} ${ctx.signal}`);
    return;
  }

  const leg = await findCanaryLeg(canaryKey, symbol);
  if (!leg) {
    await notifyCanary(
      `🐤 <b>Momentum canary: нет ноги на BingX</b>\n`
      + `Источник: ${ctx.apiKeyName} ${symbol} ${ctx.signal}\n`
      + `Цель ${canaryKey}: активная momentum_scalp_tv нога не найдена`,
    );
    return;
  }

  if (leg.state !== 'flat') {
    logger.info(`[momentum-canary] skip mirror ${canaryKey} ${symbol}: state=${leg.state}`);
    return;
  }

  try {
    const { executeStrategy } = await import('./strategy');
    const result = await executeStrategy(canaryKey, leg.id, {
      source: 'auto',
      closedBarOnly: true,
      dedupeClosedBar: true,
    });
    const action = String((result as { action?: string })?.action || '');
    const opened = action.includes('opened_') || action.includes('reopened_');
    if (opened) {
      await disarmCanary(config, {
        triggeredAt: new Date().toISOString(),
        lastSource: `mirror:${ctx.apiKeyName}:${symbol}:${ctx.signal}`,
      });
      await notifyCanary(
        `🐤 <b>Momentum BingX canary OK (mirror)</b>\n`
        + `Источник: ${ctx.apiKeyName} ${symbol} ${ctx.signal}\n`
        + `BingX: <b>${canaryKey}</b> S#${leg.id} → ${action}`,
      );
      return;
    }

    await notifyCanary(
      `🐤 <b>Momentum canary: mirror без входа</b>\n`
      + `Источник: ${ctx.apiKeyName} ${symbol} ${ctx.signal}\n`
      + `BingX ${canaryKey} S#${leg.id}: ${String((result as { result?: string })?.result || action || 'no entry')}`,
    );
  } catch (error) {
    const message = (error as Error).message || String(error);
    logger.error(`[momentum-canary] mirror execute failed ${canaryKey} S#${leg.id}: ${message}`);
    await notifyCanary(
      `🚨 <b>Momentum BingX canary FAIL</b>\n`
      + `Источник: ${ctx.apiKeyName} ${symbol} ${ctx.signal}\n`
      + `BingX ${canaryKey} S#${leg.id}: ${message}`,
    );
  }
};

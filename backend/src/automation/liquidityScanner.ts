import { getTickersSnapshot } from '../bot/exchange';
import { getTradingSystem, listTradingSystems } from '../bot/tradingSystems';
import { db } from '../utils/database';
import logger from '../utils/logger';

type ScannerOptions = {
  topUniverseLimit?: number;
  maxAddSuggestions?: number;
  maxReplaceSuggestions?: number;
};

type TickerItem = {
  symbol: string;
  volume24h: number;
  turnover24h: number;
  lastPrice: number;
  change24hPercent: number;
};

type LiquiditySuggestion = {
  systemId: number;
  symbol: string;
  suggestedAction: 'add' | 'replace' | 'watch';
  score: number;
  details: Record<string, any>;
};

const toFinite = (value: any, fallback: number = 0): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const median = (values: number[]): number => {
  const sorted = values
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (sorted.length === 0) {
    return 0;
  }

  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    return (sorted[mid - 1] + sorted[mid]) / 2;
  }

  return sorted[mid];
};

const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const row = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(row.id);
};

const shouldScanSystemNow = async (systemId: number, intervalHours: number): Promise<boolean> => {
  const row = await db.get(
    `SELECT MAX(created_at) AS last_scan_at
     FROM liquidity_scan_suggestions
     WHERE system_id = ?`,
    [systemId]
  );

  const last = toFinite(row?.last_scan_at, 0);
  if (!last) {
    return true;
  }

  const dueAt = last + Math.max(1, intervalHours) * 3600_000;
  return Date.now() >= dueAt;
};

const existsSimilarSuggestion = async (
  systemId: number,
  symbol: string,
  action: 'add' | 'replace' | 'watch'
): Promise<boolean> => {
  const since = Date.now() - 24 * 3600_000;
  const row = await db.get(
    `SELECT id
     FROM liquidity_scan_suggestions
     WHERE system_id = ?
       AND symbol = ?
       AND suggested_action = ?
       AND created_at > ?
     ORDER BY id DESC
     LIMIT 1`,
    [systemId, symbol, action, since]
  );

  return Boolean(row);
};

const saveSuggestion = async (
  apiKeyId: number,
  suggestion: LiquiditySuggestion
): Promise<void> => {
  await db.run(
    `INSERT INTO liquidity_scan_suggestions (
      api_key_id,
      system_id,
      symbol,
      market_mode,
      suggested_action,
      score,
      details_json,
      status,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      apiKeyId,
      suggestion.systemId,
      suggestion.symbol,
      'mono',
      suggestion.suggestedAction,
      suggestion.score,
      JSON.stringify(suggestion.details || {}),
      'new',
      Date.now(),
    ]
  );
};

export const runLiquidityScanForApiKey = async (
  apiKeyName: string,
  options?: ScannerOptions
): Promise<{
  apiKeyName: string;
  scannedSystems: number;
  createdSuggestions: number;
  skippedSystems: number;
  suggestions: LiquiditySuggestion[];
}> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const systems = await listTradingSystems(apiKeyName);
  const discoverySystems = systems.filter((system) => system.discovery_enabled);

  if (discoverySystems.length === 0) {
    return {
      apiKeyName,
      scannedSystems: 0,
      skippedSystems: 0,
      createdSuggestions: 0,
      suggestions: [],
    };
  }

  const snapshot = (await getTickersSnapshot(apiKeyName)) as TickerItem[];
  const filteredUniverse = snapshot
    .filter((item) => {
      const symbol = String(item.symbol || '').toUpperCase();
      return (
        symbol.endsWith('USDT') &&
        !symbol.includes('USDC') &&
        !symbol.includes('BUSD') &&
        toFinite(item.turnover24h, 0) > 0 &&
        toFinite(item.lastPrice, 0) > 0
      );
    })
    .sort((left, right) => toFinite(right.turnover24h, 0) - toFinite(left.turnover24h, 0))
    .slice(0, Math.max(20, Math.floor(toFinite(options?.topUniverseLimit, 120))));

  const turnoverBySymbol = new Map<string, number>();
  for (const item of filteredUniverse) {
    turnoverBySymbol.set(String(item.symbol).toUpperCase(), toFinite(item.turnover24h, 0));
  }

  const allSuggestions: LiquiditySuggestion[] = [];
  let createdSuggestions = 0;
  let skippedSystems = 0;

  for (const system of discoverySystems) {
    const systemId = Number(system.id || 0);
    if (!systemId) {
      continue;
    }

    const due = await shouldScanSystemNow(systemId, system.discovery_interval_hours);
    if (!due) {
      skippedSystems += 1;
      continue;
    }

    const full = await getTradingSystem(apiKeyName, systemId);
    const members = full.members.filter((member) => member.is_enabled);
    const currentSymbols = members
      .map((member) => String(member.strategy?.base_symbol || '').toUpperCase())
      .filter((symbol) => symbol.length > 0);
    const currentSet = new Set(currentSymbols);

    const currentTurnovers = currentSymbols.map((symbol) => toFinite(turnoverBySymbol.get(symbol), 0));
    const currentMedian = median(currentTurnovers);

    const addCandidates = filteredUniverse
      .filter((item) => !currentSet.has(String(item.symbol).toUpperCase()))
      .filter((item) => currentMedian <= 0 || toFinite(item.turnover24h, 0) >= currentMedian * 0.8)
      .slice(0, Math.max(1, Math.floor(toFinite(options?.maxAddSuggestions, 3))));

    const lowLiquidityMembers = members
      .map((member) => {
        const symbol = String(member.strategy?.base_symbol || '').toUpperCase();
        const turnover = toFinite(turnoverBySymbol.get(symbol), 0);
        return {
          member,
          symbol,
          turnover,
        };
      })
      .filter((item) => item.symbol)
      .sort((left, right) => left.turnover - right.turnover)
      .slice(0, Math.max(1, Math.floor(toFinite(options?.maxReplaceSuggestions, 2))));

    for (const candidate of addCandidates) {
      const symbol = String(candidate.symbol).toUpperCase();
      const score = currentMedian > 0
        ? toFinite(candidate.turnover24h, 0) / currentMedian
        : toFinite(candidate.turnover24h, 0);

      const suggestion: LiquiditySuggestion = {
        systemId,
        symbol,
        suggestedAction: 'add',
        score,
        details: {
          reason: 'High liquidity candidate outside current system',
          candidate_turnover24h: toFinite(candidate.turnover24h, 0),
          current_median_turnover24h: currentMedian,
        },
      };

      if (!(await existsSimilarSuggestion(systemId, symbol, 'add'))) {
        await saveSuggestion(apiKeyId, suggestion);
        allSuggestions.push(suggestion);
        createdSuggestions += 1;
      }
    }

    for (const low of lowLiquidityMembers) {
      const replacement = addCandidates.find(
        (candidate) => toFinite(candidate.turnover24h, 0) > Math.max(1, low.turnover) * 1.8
      );

      if (!replacement) {
        continue;
      }

      const symbol = String(replacement.symbol).toUpperCase();
      const score = low.turnover > 0
        ? toFinite(replacement.turnover24h, 0) / low.turnover
        : toFinite(replacement.turnover24h, 0);

      const suggestion: LiquiditySuggestion = {
        systemId,
        symbol,
        suggestedAction: 'replace',
        score,
        details: {
          reason: 'Replacement candidate has materially higher liquidity',
          replace_symbol: low.symbol,
          replace_turnover24h: low.turnover,
          candidate_turnover24h: toFinite(replacement.turnover24h, 0),
        },
      };

      if (!(await existsSimilarSuggestion(systemId, symbol, 'replace'))) {
        await saveSuggestion(apiKeyId, suggestion);
        allSuggestions.push(suggestion);
        createdSuggestions += 1;
      }
    }
  }

  // Emit analytics events for high-score replacement suggestions so they surface
  // in the admin low-lot recommendations panel immediately.
  for (const s of allSuggestions) {
    if (s.suggestedAction !== 'replace' || s.score < 2) {
      continue;
    }
    try {
      await db.run(
        `INSERT INTO strategy_runtime_events
           (api_key_name, strategy_id, strategy_name, event_type, message, details_json, resolved_at, created_at)
         VALUES (?, NULL, '', 'liquidity_trigger', ?, ?, 0, ?)`,
        [
          apiKeyName,
          `Liquidity replacement candidate: `+s.symbol+` (score `+s.score.toFixed(2)+`) for system `+s.systemId+`. `+String(s.details?.reason || ''),
          JSON.stringify({ ...s.details, systemId: s.systemId, symbol: s.symbol }),
          Date.now(),
        ]
      );
    } catch {
      // Non-critical; analytics loss is acceptable.
    }
  }

  return {
    apiKeyName,
    scannedSystems: discoverySystems.length,
    skippedSystems,
    createdSuggestions,
    suggestions: allSuggestions,
  };
};

export const listLiquiditySuggestions = async (
  apiKeyName: string,
  status: 'new' | 'accepted' | 'rejected' | 'applied' | 'all' = 'new',
  limit: number = 100
): Promise<any[]> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const safeLimit = Math.max(1, Math.min(1000, Math.floor(toFinite(limit, 100))));

  if (status === 'all') {
    return db.all(
      `SELECT *
       FROM liquidity_scan_suggestions
       WHERE api_key_id = ?
       ORDER BY created_at DESC
       LIMIT ?`,
      [apiKeyId, safeLimit]
    );
  }

  return db.all(
    `SELECT *
     FROM liquidity_scan_suggestions
     WHERE api_key_id = ? AND status = ?
     ORDER BY created_at DESC
     LIMIT ?`,
    [apiKeyId, status, safeLimit]
  );
};

export const updateLiquiditySuggestionStatus = async (
  apiKeyName: string,
  suggestionId: number,
  status: 'new' | 'accepted' | 'rejected' | 'applied'
): Promise<void> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const result: any = await db.run(
    `UPDATE liquidity_scan_suggestions
     SET status = ?
     WHERE id = ? AND api_key_id = ?`,
    [status, suggestionId, apiKeyId]
  );

  if (!result || Number(result.changes || 0) === 0) {
    throw new Error(`Liquidity suggestion not found: ${suggestionId}`);
  }

  logger.info(`Liquidity suggestion ${suggestionId} status changed to ${status} (${apiKeyName})`);
};

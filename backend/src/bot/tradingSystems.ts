import { BacktestRunRequest, BacktestRunResult, runBacktest } from '../backtest/engine';
import { Strategy } from '../config/settings';
import { db } from '../utils/database';
import { cancelAllOrders, closePosition, getPositions } from './exchange';
import { getMonitoringLatest, recordMonitoringSnapshot } from './monitoring';
import { getStrategies, updateStrategy } from './strategy';

export type TradingSystemMember = {
  id?: number;
  system_id: number;
  strategy_id: number;
  weight: number;
  member_role: string;
  is_enabled: boolean;
  notes: string;
  created_at?: string;
  strategy?: Strategy | null;
};

export type TradingSystemMetrics = {
  equity_usd: number;
  unrealized_pnl: number;
  margin_load_percent: number;
  drawdown_percent: number;
  effective_leverage: number;
  recorded_at?: string;
};

export type TradingSystem = {
  id?: number;
  api_key_id: number;
  name: string;
  description: string;
  is_active: boolean;
  auto_sync_members: boolean;
  discovery_enabled: boolean;
  discovery_interval_hours: number;
  max_members: number;
  created_at?: string;
  updated_at?: string;
  members: TradingSystemMember[];
  metrics?: TradingSystemMetrics;
};

export type TradingSystemMemberDraft = {
  strategy_id: number;
  weight?: number;
  member_role?: string;
  is_enabled?: boolean;
  notes?: string;
};

export type TradingSystemMembersSafeApplyOptions = {
  cancelRemovedOrders?: boolean;
  closeRemovedPositions?: boolean;
  syncMemberActivation?: boolean;
};

export type TradingSystemDraft = {
  name?: string;
  description?: string;
  is_active?: boolean;
  auto_sync_members?: boolean;
  discovery_enabled?: boolean;
  discovery_interval_hours?: number;
  max_members?: number;
  members?: TradingSystemMemberDraft[];
};

const safeBoolean = (value: any, fallback: boolean): boolean => {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'number') {
    return value !== 0;
  }
  const normalized = String(value).trim().toLowerCase();
  if (normalized === 'true' || normalized === '1') {
    return true;
  }
  if (normalized === 'false' || normalized === '0') {
    return false;
  }
  return fallback;
};

const safeNumber = (value: any, fallback: number): number => {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
};

const normalizeRole = (value: any): string => {
  const normalized = String(value || '').trim().toLowerCase();
  return normalized || 'core';
};

const normalizeMetricsRow = (row: any): TradingSystemMetrics | undefined => {
  if (!row) {
    return undefined;
  }

  return {
    equity_usd: safeNumber(row.equity_usd, 0),
    unrealized_pnl: safeNumber(row.unrealized_pnl, 0),
    margin_load_percent: safeNumber(row.margin_load_percent, 0),
    drawdown_percent: safeNumber(row.drawdown_percent, 0),
    effective_leverage: safeNumber(row.effective_leverage, 0),
    recorded_at: row.recorded_at,
  };
};

const getTradingSystemMetrics = async (apiKeyName: string, apiKeyId: number): Promise<TradingSystemMetrics | undefined> => {
  const latest = await db.get(
    `SELECT equity_usd, unrealized_pnl, margin_load_percent, drawdown_percent, effective_leverage, recorded_at
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY datetime(recorded_at) DESC
     LIMIT 1`,
    [apiKeyId]
  );

  if (latest) {
    return normalizeMetricsRow(latest);
  }

  // If no historical snapshot exists yet, try to create one on demand.
  try {
    await recordMonitoringSnapshot(apiKeyName);
    const created = await getMonitoringLatest(apiKeyName);
    return normalizeMetricsRow(created);
  } catch {
    return undefined;
  }
};

const normalizeSystemRow = (row: any, members: TradingSystemMember[], metrics?: TradingSystemMetrics): TradingSystem => {
  return {
    id: Number(row.id),
    api_key_id: Number(row.api_key_id),
    name: String(row.name || ''),
    description: String(row.description || ''),
    is_active: safeBoolean(row.is_active, false),
    auto_sync_members: safeBoolean(row.auto_sync_members, false),
    discovery_enabled: safeBoolean(row.discovery_enabled, false),
    discovery_interval_hours: Math.max(1, Math.floor(safeNumber(row.discovery_interval_hours, 24))),
    max_members: Math.max(1, Math.floor(safeNumber(row.max_members, 8))),
    created_at: row.created_at,
    updated_at: row.updated_at,
    members,
    metrics,
  };
};

const normalizeMemberRow = (row: any, strategyMap: Map<number, Strategy>): TradingSystemMember => {
  const strategyId = Number(row.strategy_id);
  return {
    id: Number(row.id),
    system_id: Number(row.system_id),
    strategy_id: strategyId,
    weight: Math.max(0, safeNumber(row.weight, 1)),
    member_role: normalizeRole(row.member_role),
    is_enabled: safeBoolean(row.is_enabled, true),
    notes: String(row.notes || ''),
    created_at: row.created_at,
    strategy: strategyMap.get(strategyId) || null,
  };
};

const getApiKeyId = async (apiKeyName: string): Promise<number> => {
  const row = await db.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!row) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  return Number(row.id);
};

const getTradingSystemRow = async (apiKeyId: number, systemId: number): Promise<any> => {
  const row = await db.get(
    `SELECT *
     FROM trading_systems
     WHERE id = ? AND api_key_id = ?`,
    [systemId, apiKeyId]
  );

  if (!row) {
    throw new Error(`Trading system not found: ${systemId}`);
  }

  return row;
};

const loadTradingSystemsWithMembers = async (apiKeyName: string, rows: any[]): Promise<TradingSystem[]> => {
  const systems = Array.isArray(rows) ? rows : [];
  if (systems.length === 0) {
    return [];
  }

  const strategyMap = new Map<number, Strategy>();
  const strategies = await getStrategies(apiKeyName, { includeLotPreview: false });
  for (const strategy of strategies) {
    if (strategy.id) {
      strategyMap.set(Number(strategy.id), strategy);
    }
  }

  const systemIds = systems.map((row) => Number(row.id)).filter((id) => Number.isFinite(id) && id > 0);
  const placeholders = systemIds.map(() => '?').join(', ');
  const memberRows = await db.all(
    `SELECT *
     FROM trading_system_members
     WHERE system_id IN (${placeholders})
     ORDER BY id ASC`,
    systemIds
  );

  const membersBySystemId = new Map<number, TradingSystemMember[]>();
  for (const row of Array.isArray(memberRows) ? memberRows : []) {
    const systemId = Number(row.system_id);
    const list = membersBySystemId.get(systemId) || [];
    list.push(normalizeMemberRow(row, strategyMap));
    membersBySystemId.set(systemId, list);
  }

  // Load metrics for each system (by api_key_id)
  const metricsMap = new Map<number, TradingSystemMetrics | undefined>();
  for (const row of systems) {
    const apiKeyId = Number(row.api_key_id);
    if (!metricsMap.has(apiKeyId)) {
      const metrics = await getTradingSystemMetrics(apiKeyName, apiKeyId);
      metricsMap.set(apiKeyId, metrics);
    }
  }

  return systems.map((row) => {
    const apiKeyId = Number(row.api_key_id);
    const metrics = metricsMap.get(apiKeyId);
    return normalizeSystemRow(row, membersBySystemId.get(Number(row.id)) || [], metrics);
  });
};

const validateMembers = async (
  apiKeyName: string,
  maxMembers: number,
  members: TradingSystemMemberDraft[]
): Promise<void> => {
  const uniqueIds = new Set<number>();
  const strategies = await getStrategies(apiKeyName, { includeLotPreview: false });
  const strategyIds = new Set(strategies.map((strategy) => Number(strategy.id)).filter((id) => Number.isFinite(id) && id > 0));

  if (members.length > maxMembers) {
    throw new Error(`Trading system member count ${members.length} exceeds max_members=${maxMembers}`);
  }

  for (const member of members) {
    const strategyId = Number(member.strategy_id);
    if (!Number.isFinite(strategyId) || strategyId <= 0) {
      throw new Error('Each trading system member requires a valid strategy_id');
    }
    if (uniqueIds.has(strategyId)) {
      throw new Error(`Duplicate strategy_id in trading system members: ${strategyId}`);
    }
    if (!strategyIds.has(strategyId)) {
      throw new Error(`Strategy ${strategyId} does not belong to api key ${apiKeyName}`);
    }
    uniqueIds.add(strategyId);
  }
};

export const listTradingSystems = async (apiKeyName: string): Promise<TradingSystem[]> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const rows = await db.all(
    `SELECT *
     FROM trading_systems
     WHERE api_key_id = ?
     ORDER BY id DESC`,
    [apiKeyId]
  );

  return loadTradingSystemsWithMembers(apiKeyName, rows);
};

export const getTradingSystem = async (apiKeyName: string, systemId: number): Promise<TradingSystem> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const row = await getTradingSystemRow(apiKeyId, systemId);
  const systems = await loadTradingSystemsWithMembers(apiKeyName, [row]);
  const system = systems[0];

  if (!system) {
    throw new Error(`Trading system not found: ${systemId}`);
  }

  return system;
};

export const createTradingSystem = async (apiKeyName: string, draft: TradingSystemDraft): Promise<TradingSystem> => {
  const apiKeyId = await getApiKeyId(apiKeyName);
  const name = String(draft.name || '').trim();
  if (!name) {
    throw new Error('Trading system name is required');
  }

  const description = String(draft.description || '').trim();
  const isActive = safeBoolean(draft.is_active, false);
  const autoSyncMembers = safeBoolean(draft.auto_sync_members, false);
  const discoveryEnabled = safeBoolean(draft.discovery_enabled, false);
  const discoveryIntervalHours = Math.max(1, Math.floor(safeNumber(draft.discovery_interval_hours, 24)));
  const maxMembers = Math.max(1, Math.floor(safeNumber(draft.max_members, 8)));
  const members = Array.isArray(draft.members) ? draft.members : [];

  await validateMembers(apiKeyName, maxMembers, members);

  const result: any = await db.run(
    `INSERT INTO trading_systems (
      api_key_id,
      name,
      description,
      is_active,
      auto_sync_members,
      discovery_enabled,
      discovery_interval_hours,
      max_members,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      apiKeyId,
      name,
      description,
      isActive ? 1 : 0,
      autoSyncMembers ? 1 : 0,
      discoveryEnabled ? 1 : 0,
      discoveryIntervalHours,
      maxMembers,
    ]
  );

  const systemId = Number(result.lastID);
  if (members.length > 0) {
    await replaceTradingSystemMembers(apiKeyName, systemId, members);
  }

  return getTradingSystem(apiKeyName, systemId);
};

export const updateTradingSystem = async (
  apiKeyName: string,
  systemId: number,
  patch: TradingSystemDraft
): Promise<TradingSystem> => {
  const existing = await getTradingSystem(apiKeyName, systemId);
  const requestedMaxMembers = patch.max_members !== undefined
    ? Math.max(1, Math.floor(safeNumber(patch.max_members, existing.max_members)))
    : existing.max_members;
  // Never shrink max_members below current composition in a metadata update.
  // Member downsize should happen via replaceTradingSystemMembers first.
  const nextMaxMembers = Math.max(requestedMaxMembers, existing.members.length);

  const updates: string[] = [];
  const params: any[] = [];
  const push = (column: string, value: any) => {
    updates.push(`${column} = ?`);
    params.push(value);
  };

  if (patch.name !== undefined) {
    const name = String(patch.name || '').trim();
    if (!name) {
      throw new Error('Trading system name must not be empty');
    }
    push('name', name);
  }
  if (patch.description !== undefined) {
    push('description', String(patch.description || '').trim());
  }
  if (patch.is_active !== undefined) {
    push('is_active', safeBoolean(patch.is_active, existing.is_active) ? 1 : 0);
  }
  if (patch.auto_sync_members !== undefined) {
    push('auto_sync_members', safeBoolean(patch.auto_sync_members, existing.auto_sync_members) ? 1 : 0);
  }
  if (patch.discovery_enabled !== undefined) {
    push('discovery_enabled', safeBoolean(patch.discovery_enabled, existing.discovery_enabled) ? 1 : 0);
  }
  if (patch.discovery_interval_hours !== undefined) {
    push('discovery_interval_hours', Math.max(1, Math.floor(safeNumber(patch.discovery_interval_hours, existing.discovery_interval_hours))));
  }
  if (patch.max_members !== undefined) {
    push('max_members', nextMaxMembers);
  }

  if (updates.length > 0) {
    await db.run(
      `UPDATE trading_systems
       SET ${updates.join(', ')}, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND api_key_id = ?`,
      [...params, systemId, existing.api_key_id]
    );
  }

  return getTradingSystem(apiKeyName, systemId);
};

export const deleteTradingSystem = async (apiKeyName: string, systemId: number): Promise<void> => {
  const existing = await getTradingSystem(apiKeyName, systemId);

  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.run('DELETE FROM trading_system_members WHERE system_id = ?', [systemId]);
    await db.run('DELETE FROM trading_systems WHERE id = ? AND api_key_id = ?', [systemId, existing.api_key_id]);
    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
};

export const replaceTradingSystemMembers = async (
  apiKeyName: string,
  systemId: number,
  members: TradingSystemMemberDraft[]
): Promise<TradingSystem> => {
  const existing = await getTradingSystem(apiKeyName, systemId);
  const nextMembers = Array.isArray(members) ? members : [];

  await validateMembers(apiKeyName, existing.max_members, nextMembers);

  await db.exec('BEGIN IMMEDIATE');
  try {
    await db.run('DELETE FROM trading_system_members WHERE system_id = ?', [systemId]);

    for (const member of nextMembers) {
      await db.run(
        `INSERT INTO trading_system_members (
          system_id,
          strategy_id,
          weight,
          member_role,
          is_enabled,
          notes,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`,
        [
          systemId,
          Number(member.strategy_id),
          Math.max(0, safeNumber(member.weight, 1)),
          normalizeRole(member.member_role),
          safeBoolean(member.is_enabled, true) ? 1 : 0,
          String(member.notes || '').trim(),
        ]
      );
    }

    await db.exec('COMMIT');
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }

  return getTradingSystem(apiKeyName, systemId);
};

const collectMemberSymbols = (member: TradingSystemMember): string[] => {
  const strategy = member.strategy;
  if (!strategy) {
    return [];
  }

  const base = String(strategy.base_symbol || '').trim().toUpperCase();
  const quote = String(strategy.quote_symbol || '').trim().toUpperCase();
  if (!base) {
    return [];
  }

  if (String(strategy.market_mode || 'synthetic') === 'mono') {
    return [base];
  }

  return [base, quote].filter(Boolean);
};

export const replaceTradingSystemMembersSafely = async (
  apiKeyName: string,
  systemId: number,
  members: TradingSystemMemberDraft[],
  options?: TradingSystemMembersSafeApplyOptions
): Promise<{ system: TradingSystem; orchestration: Record<string, unknown> }> => {
  const current = await getTradingSystem(apiKeyName, systemId);
  const nextMembers = Array.isArray(members) ? members : [];
  const settings = {
    cancelRemovedOrders: options?.cancelRemovedOrders !== false,
    closeRemovedPositions: options?.closeRemovedPositions !== false,
    syncMemberActivation: options?.syncMemberActivation !== false,
  };

  const strategyMap = new Map<number, Strategy>();
  const allStrategies = await getStrategies(apiKeyName, { includeLotPreview: false });
  for (const strategy of allStrategies) {
    if (strategy.id) {
      strategyMap.set(Number(strategy.id), strategy);
    }
  }

  const currentEnabledMembers = current.members.filter((member) => member.is_enabled);
  const nextEnabledMembers = nextMembers
    .filter((member) => safeBoolean(member.is_enabled, true))
    .map((member) => ({
      strategyId: Number(member.strategy_id),
      strategy: strategyMap.get(Number(member.strategy_id)) || null,
    }));

  const currentStrategyIds = new Set(currentEnabledMembers.map((member) => Number(member.strategy_id)));
  const nextStrategyIds = new Set(nextEnabledMembers.map((member) => Number(member.strategyId)).filter((id) => Number.isFinite(id) && id > 0));

  const removedStrategyIds = Array.from(currentStrategyIds).filter((id) => !nextStrategyIds.has(id));
  const addedStrategyIds = Array.from(nextStrategyIds).filter((id) => !currentStrategyIds.has(id));

  const currentSymbols = new Set<string>();
  for (const member of currentEnabledMembers) {
    for (const symbol of collectMemberSymbols(member)) {
      currentSymbols.add(symbol);
    }
  }

  const nextSymbols = new Set<string>();
  for (const item of nextEnabledMembers) {
    if (!item.strategy) {
      continue;
    }
    const base = String(item.strategy.base_symbol || '').trim().toUpperCase();
    const quote = String(item.strategy.quote_symbol || '').trim().toUpperCase();
    if (!base) {
      continue;
    }
    if (String(item.strategy.market_mode || 'synthetic') === 'mono') {
      nextSymbols.add(base);
    } else {
      nextSymbols.add(base);
      if (quote) {
        nextSymbols.add(quote);
      }
    }
  }

  const removedSymbols = Array.from(currentSymbols).filter((symbol) => !nextSymbols.has(symbol));
  const warnings: string[] = [];

  if (settings.cancelRemovedOrders) {
    for (const symbol of removedSymbols) {
      try {
        await cancelAllOrders(apiKeyName, symbol);
      } catch (error) {
        warnings.push(`cancelAllOrders failed for ${symbol}: ${(error as Error).message}`);
      }
    }
  }

  let closedPositions = 0;
  if (settings.closeRemovedPositions) {
    for (const symbol of removedSymbols) {
      try {
        const positions = await getPositions(apiKeyName, symbol);
        const actionable = positions.filter((position: any) => Number.parseFloat(String(position?.size || '0')) > 0);
        for (const position of actionable) {
          const qty = String(position?.size || '0');
          const side = String(position?.side || '') as 'Buy' | 'Sell';
          if (!qty || qty === '0' || (side !== 'Buy' && side !== 'Sell')) {
            continue;
          }
          await closePosition(apiKeyName, symbol, qty, side);
          closedPositions += 1;
        }
      } catch (error) {
        warnings.push(`close positions failed for ${symbol}: ${(error as Error).message}`);
      }
    }
  }

  const system = await replaceTradingSystemMembers(apiKeyName, systemId, nextMembers);

  if (settings.syncMemberActivation) {
    for (const strategyId of removedStrategyIds) {
      try {
        await updateStrategy(apiKeyName, strategyId, { is_active: false }, { source: 'system_safe_replace_removed' });
      } catch (error) {
        warnings.push(`deactivate strategy ${strategyId} failed: ${(error as Error).message}`);
      }
    }

    for (const strategyId of addedStrategyIds) {
      try {
        await updateStrategy(apiKeyName, strategyId, { is_active: Boolean(system.is_active) }, { source: 'system_safe_replace_added' });
      } catch (error) {
        warnings.push(`activate strategy ${strategyId} failed: ${(error as Error).message}`);
      }
    }
  }

  return {
    system,
    orchestration: {
      removedSymbols,
      removedStrategyIds,
      addedStrategyIds,
      closedPositions,
      warnings,
      options: settings,
    },
  };
};

export const setTradingSystemActivation = async (
  apiKeyName: string,
  systemId: number,
  isActive: boolean,
  syncMembers: boolean
): Promise<TradingSystem> => {
  const existing = await getTradingSystem(apiKeyName, systemId);

  await updateTradingSystem(apiKeyName, systemId, {
    is_active: isActive,
  });

  if (syncMembers) {
    for (const member of existing.members) {
      if (!member.is_enabled) {
        continue;
      }
      await updateStrategy(apiKeyName, member.strategy_id, {
        is_active: isActive,
      });
    }
  }

  return getTradingSystem(apiKeyName, systemId);
};

export const runTradingSystemBacktest = async (
  apiKeyName: string,
  systemId: number,
  requestPatch?: Partial<BacktestRunRequest> & {
    memberWeights?: Record<string, number>;
    enabledMembers?: Record<string, boolean>;
    riskMultiplier?: number;
  }
): Promise<BacktestRunResult> => {
  const system = await getTradingSystem(apiKeyName, systemId);

  const enabledMembersPatch = requestPatch?.enabledMembers || {};
  const memberWeightsPatch = requestPatch?.memberWeights || {};

  const enabledMembers = system.members.filter((member) => {
    const override = enabledMembersPatch[String(member.strategy_id)];
    return override === undefined ? member.is_enabled : override === true;
  });

  const strategyIds = system.members
    .filter((member) => enabledMembers.some((enabled) => enabled.strategy_id === member.strategy_id))
    .map((member) => Number(member.strategy_id))
    .filter((id) => Number.isFinite(id) && id > 0);

  if (strategyIds.length === 0) {
    throw new Error(`Trading system ${systemId} has no enabled members to backtest`);
  }

  const incomingInitial = Number(requestPatch?.initialBalance);
  const initialBalance = Number.isFinite(incomingInitial) && incomingInitial > 0
    ? incomingInitial
    : 1000;

  const incomingRiskMultiplier = Number(requestPatch?.riskMultiplier);
  const riskMultiplier = Number.isFinite(incomingRiskMultiplier)
    ? Math.max(0.25, Math.min(3, incomingRiskMultiplier))
    : 1;

  const baseResult = await runBacktest({
    ...(requestPatch || {}),
    apiKeyName,
    mode: 'portfolio',
    strategyIds,
    initialBalance,
    strategyId: undefined,
  });

  if (Math.abs(riskMultiplier - 1) < 1e-9 || !Array.isArray(baseResult.equityCurve) || baseResult.equityCurve.length === 0) {
    return baseResult;
  }

  const initial = Number(baseResult.summary.initialBalance);
  const sortedBaseCurve = [...baseResult.equityCurve].sort((left, right) => Number(left.time) - Number(right.time));
  const recomposedEquityCurve: typeof sortedBaseCurve = [];
  let prevRiskEquity = Number.isFinite(initial) && initial > 0 ? initial : Number(sortedBaseCurve[0]?.equity || 1000);

  for (let index = 0; index < sortedBaseCurve.length; index += 1) {
    const point = sortedBaseCurve[index];
    if (index === 0) {
      const seeded = {
        ...point,
        equity: Number(prevRiskEquity.toFixed(6)),
      };
      recomposedEquityCurve.push(seeded);
      continue;
    }

    const prevBase = Number(sortedBaseCurve[index - 1]?.equity ?? sortedBaseCurve[0]?.equity ?? prevRiskEquity);
    const currBase = Number(point.equity);
    const baseReturn = Number.isFinite(prevBase) && Math.abs(prevBase) > 1e-9
      ? (currBase / prevBase) - 1
      : 0;
    const adjustedReturn = Math.max(-0.99, baseReturn * riskMultiplier);
    prevRiskEquity = prevRiskEquity * (1 + adjustedReturn);

    recomposedEquityCurve.push({
      ...point,
      equity: Number(prevRiskEquity.toFixed(6)),
    });
  }

  let peak = initial;
  let maxDrawdownAbsolute = 0;
  let maxDrawdownPercent = 0;

  for (const point of recomposedEquityCurve) {
    const equity = Number(point.equity);
    if (equity > peak) {
      peak = equity;
    }
    const drawdownAbs = peak - equity;
    const drawdownPct = peak > 0 ? (drawdownAbs / peak) * 100 : 0;
    if (drawdownAbs > maxDrawdownAbsolute) {
      maxDrawdownAbsolute = drawdownAbs;
    }
    if (drawdownPct > maxDrawdownPercent) {
      maxDrawdownPercent = drawdownPct;
    }
  }

  const finalEquity = Number(recomposedEquityCurve[recomposedEquityCurve.length - 1]?.equity ?? initial);
  const totalReturnPercent = initial > 0 ? ((finalEquity / initial) - 1) * 100 : 0;

  return {
    ...baseResult,
    equityCurve: recomposedEquityCurve,
    summary: {
      ...baseResult.summary,
      finalEquity: Number(finalEquity.toFixed(6)),
      totalReturnPercent: Number(totalReturnPercent.toFixed(6)),
      maxDrawdownAbsolute: Number(maxDrawdownAbsolute.toFixed(6)),
      maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(6)),
    },
  };
};
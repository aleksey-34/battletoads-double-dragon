import { BacktestRunRequest, BacktestRunResult, runBacktest } from '../backtest/engine';
import { Strategy } from '../config/settings';
import { db } from '../utils/database';
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

const getTradingSystemMetrics = async (apiKeyId: number): Promise<TradingSystemMetrics | undefined> => {
  const row = await db.get(
    `SELECT equity_usd, unrealized_pnl, margin_load_percent, drawdown_percent, effective_leverage, recorded_at
     FROM monitoring_snapshots
     WHERE api_key_id = ?
     ORDER BY datetime(recorded_at) DESC
     LIMIT 1`,
    [apiKeyId]
  );

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
      const metrics = await getTradingSystemMetrics(apiKeyId);
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
  const nextMaxMembers = patch.max_members !== undefined
    ? Math.max(1, Math.floor(safeNumber(patch.max_members, existing.max_members)))
    : existing.max_members;

  if (existing.members.length > nextMaxMembers) {
    throw new Error(`Current member count ${existing.members.length} exceeds requested max_members=${nextMaxMembers}`);
  }

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

  const weightedMembers = enabledMembers.map((member) => {
    const overrideWeight = Number(memberWeightsPatch[String(member.strategy_id)]);
    const weight = Number.isFinite(overrideWeight) ? overrideWeight : Number(member.weight);
    return Math.max(0, weight);
  });

  const avgWeight = weightedMembers.length > 0
    ? weightedMembers.reduce((sum, value) => sum + value, 0) / weightedMembers.length
    : 1;

  const normalizedRiskMultiplier = Number.isFinite(avgWeight) && avgWeight > 0 ? avgWeight : 1;

  const incomingInitial = Number(requestPatch?.initialBalance);
  const initialBalance = Number.isFinite(incomingInitial) && incomingInitial > 0
    ? incomingInitial
    : 1000 * normalizedRiskMultiplier;

  return runBacktest({
    ...(requestPatch || {}),
    apiKeyName,
    mode: 'portfolio',
    strategyIds,
    initialBalance,
    strategyId: undefined,
  });
};
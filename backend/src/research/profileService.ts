/**
 * Research profile service:
 * - CRUD for strategy_profiles (candidate management)
 * - Publish gate: promote a research profile → runtime strategy
 * - Archive / revoke publish
 */
import crypto from 'crypto';
import { getResearchDb } from './db';
import logger from '../utils/logger';
import { db as mainDb } from '../utils/database';

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProfileStatus = 'candidate' | 'published' | 'archived';
export type ProfileOrigin = 'sweep_candidate' | 'manual' | 'imported';

export type StrategyProfile = {
  id: number;
  name: string;
  description: string;
  origin: ProfileOrigin;
  strategy_type: string;
  market_mode: string;
  base_symbol: string | null;
  quote_symbol: string | null;
  interval: string;
  config_json: string;
  metrics_summary_json: string;
  sweep_run_id: number | null;
  published_strategy_id: number | null;
  status: ProfileStatus;
  tags_json: string;
  created_at: string;
  updated_at: string;
};

export type CreateProfileInput = {
  name: string;
  description?: string;
  origin?: ProfileOrigin;
  strategy_type?: string;
  market_mode?: string;
  base_symbol?: string | null;
  quote_symbol?: string | null;
  interval?: string;
  config: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  sweep_run_id?: number | null;
  tags?: string[];
};

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export const listProfiles = async (options?: {
  status?: ProfileStatus;
  sweep_run_id?: number;
  limit?: number;
  offset?: number;
}): Promise<StrategyProfile[]> => {
  const db = getResearchDb();
  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (options?.status) {
    conditions.push('status = ?');
    params.push(options.status);
  }
  if (options?.sweep_run_id !== undefined) {
    conditions.push('sweep_run_id = ?');
    params.push(options.sweep_run_id);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const limitClause = options?.limit ? `LIMIT ${Math.floor(options.limit)} OFFSET ${Math.floor(options?.offset ?? 0)}` : '';

  const rows = await db.all(
    `SELECT * FROM strategy_profiles ${where} ORDER BY created_at DESC ${limitClause}`,
    params
  );
  return (rows || []) as StrategyProfile[];
};

export const getProfileById = async (id: number): Promise<StrategyProfile | null> => {
  const db = getResearchDb();
  const row = await db.get('SELECT * FROM strategy_profiles WHERE id = ?', [id]);
  return (row || null) as StrategyProfile | null;
};

export const createProfile = async (input: CreateProfileInput): Promise<StrategyProfile> => {
  const db = getResearchDb();
  const result = await db.run(
    `INSERT INTO strategy_profiles (
       name, description, origin, strategy_type, market_mode,
       base_symbol, quote_symbol, interval,
       config_json, metrics_summary_json, sweep_run_id,
       tags_json, status, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      input.name,
      input.description ?? '',
      input.origin ?? 'manual',
      input.strategy_type ?? 'DD_BattleToads',
      input.market_mode ?? 'mono',
      input.base_symbol ?? null,
      input.quote_symbol ?? null,
      input.interval ?? '1h',
      JSON.stringify(input.config),
      JSON.stringify(input.metrics ?? {}),
      input.sweep_run_id ?? null,
      JSON.stringify(input.tags ?? []),
    ]
  );

  const id = result?.lastID;
  if (!id) {
    throw new Error('Failed to create strategy profile');
  }

  const created = await getProfileById(id);
  if (!created) {
    throw new Error(`Profile ${id} not found after creation`);
  }
  logger.info(`Research profile created: #${id} "${input.name}"`);
  return created;
};

export const updateProfile = async (
  id: number,
  patch: Partial<Pick<CreateProfileInput, 'name' | 'description' | 'config' | 'metrics' | 'tags'>>
): Promise<StrategyProfile> => {
  const db = getResearchDb();
  const existing = await getProfileById(id);
  if (!existing) {
    throw new Error(`Profile not found: ${id}`);
  }

  const updates: string[] = [];
  const params: (string | number | null)[] = [];

  if (patch.name !== undefined) {
    updates.push('name = ?');
    params.push(patch.name);
  }
  if (patch.description !== undefined) {
    updates.push('description = ?');
    params.push(patch.description);
  }
  if (patch.config !== undefined) {
    updates.push('config_json = ?');
    params.push(JSON.stringify(patch.config));
  }
  if (patch.metrics !== undefined) {
    updates.push('metrics_summary_json = ?');
    params.push(JSON.stringify(patch.metrics));
  }
  if (patch.tags !== undefined) {
    updates.push('tags_json = ?');
    params.push(JSON.stringify(patch.tags));
  }

  if (updates.length === 0) {
    return existing;
  }

  updates.push('updated_at = CURRENT_TIMESTAMP');
  params.push(id);

  await db.run(
    `UPDATE strategy_profiles SET ${updates.join(', ')} WHERE id = ?`,
    params
  );

  const updated = await getProfileById(id);
  if (!updated) {
    throw new Error(`Profile ${id} not found after update`);
  }
  return updated;
};

export const archiveProfile = async (id: number): Promise<void> => {
  const db = getResearchDb();
  await db.run(
    `UPDATE strategy_profiles SET status = 'archived', updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    [id]
  );
  logger.info(`Research profile #${id} archived`);
};

// ─── Publish Gate ─────────────────────────────────────────────────────────────

/**
 * Publish a research profile to the runtime trading DB.
 *
 * Creates (or updates) a row in the main `strategies` table with:
 *  - is_runtime = 1
 *  - origin = 'published'
 *  - source_profile_id = profile.id
 *  - is_active = 0 (admin must manually start it)
 *
 * A publish_log record is always written.
 */
export const publishProfileToRuntime = async (
  profileId: number,
  options?: { apiKeyName: string; publishedBy?: string; notes?: string }
): Promise<{ runtimeStrategyId: number }> => {
  const researchDb = getResearchDb();

  const profile = await getProfileById(profileId);
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }
  if (profile.status === 'archived') {
    throw new Error(`Cannot publish archived profile #${profileId}`);
  }

  const apiKeyName = options?.apiKeyName;
  if (!apiKeyName) {
    throw new Error('apiKeyName is required for publishing to runtime');
  }

  // Look up api_key_id in main DB
  const apiKeyRow = await mainDb.get('SELECT id FROM api_keys WHERE name = ?', [apiKeyName]);
  if (!apiKeyRow?.id) {
    throw new Error(`API key not found: ${apiKeyName}`);
  }
  const apiKeyId = Number(apiKeyRow.id);

  let config: Record<string, unknown> = {};
  try {
    config = JSON.parse(profile.config_json) as Record<string, unknown>;
  } catch {
    // config remains {}
  }

  const existingStrategyId = profile.published_strategy_id;

  let runtimeStrategyId: number;

  if (existingStrategyId) {
    // Update existing runtime strategy from profile (do not touch is_active)
    await mainDb.run(
      `UPDATE strategies
       SET origin = 'published', source_profile_id = ?, published_at = CURRENT_TIMESTAMP,
           is_runtime = 1, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [profileId, existingStrategyId]
    );
    runtimeStrategyId = existingStrategyId;
    logger.info(`Research profile #${profileId} re-synced to runtime strategy #${runtimeStrategyId}`);
  } else {
    // Create new runtime strategy row — paused by default (admin must start)
    const strategyName = String(config.name || profile.name);
    const result = await mainDb.run(
      `INSERT INTO strategies (
         name, api_key_id, strategy_type, market_mode,
         base_symbol, quote_symbol, interval,
         is_active, is_runtime, origin, source_profile_id, published_at,
         auto_update,
         created_at, updated_at
       ) VALUES (
         ?, ?, ?, ?,
         ?, ?, ?,
         0, 1, 'published', ?, CURRENT_TIMESTAMP,
         1,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )`,
      [
        strategyName,
        apiKeyId,
        String(config.strategy_type ?? profile.strategy_type ?? 'DD_BattleToads'),
        String(config.market_mode ?? profile.market_mode ?? 'mono'),
        String(config.base_symbol ?? profile.base_symbol ?? ''),
        String(config.quote_symbol ?? profile.quote_symbol ?? ''),
        String(config.interval ?? profile.interval ?? '1h'),
        profileId,
      ]
    );
    runtimeStrategyId = Number(result?.lastID);
    if (!runtimeStrategyId) {
      throw new Error('Failed to create runtime strategy from profile');
    }
    logger.info(`Research profile #${profileId} published as new runtime strategy #${runtimeStrategyId}`);
  }

  // Update profile status and link
  await researchDb.run(
    `UPDATE strategy_profiles
     SET status = 'published', published_strategy_id = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [runtimeStrategyId, profileId]
  );

  // Write publish log
  await researchDb.run(
    `INSERT INTO publish_log (profile_id, runtime_strategy_id, action, published_by, notes, created_at)
     VALUES (?, ?, 'publish', ?, ?, CURRENT_TIMESTAMP)`,
    [profileId, runtimeStrategyId, options?.publishedBy ?? 'admin', options?.notes ?? '']
  );

  return { runtimeStrategyId };
};

/**
 * Revoke a published profile from runtime (sets is_runtime=0 on the strategy).
 * Does NOT delete the runtime strategy — just marks it as no longer runtime-managed.
 */
export const revokePublishedProfile = async (
  profileId: number,
  options?: { publishedBy?: string; notes?: string }
): Promise<void> => {
  const researchDb = getResearchDb();

  const profile = await getProfileById(profileId);
  if (!profile) {
    throw new Error(`Profile not found: ${profileId}`);
  }

  if (profile.published_strategy_id) {
    await mainDb.run(
      `UPDATE strategies
       SET is_runtime = 0, is_active = 0, updated_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [profile.published_strategy_id]
    );
    logger.info(`Runtime strategy #${profile.published_strategy_id} revoked from runtime (profile #${profileId})`);
  }

  // Update profile status back to candidate
  await researchDb.run(
    `UPDATE strategy_profiles
     SET status = 'candidate', updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [profileId]
  );

  // Write revoke log entry
  await researchDb.run(
    `INSERT INTO publish_log (profile_id, runtime_strategy_id, action, published_by, notes, created_at)
     VALUES (?, ?, 'revoke', ?, ?, CURRENT_TIMESTAMP)`,
    [
      profileId,
      profile.published_strategy_id ?? null,
      options?.publishedBy ?? 'admin',
      options?.notes ?? '',
    ]
  );
};

// ─── Sweep import helpers ─────────────────────────────────────────────────────

/**
 * Register a historical sweep run from a result JSON file path.
 * Returns the sweep_run id.
 */
export const registerSweepRun = async (opts: {
  name: string;
  description?: string;
  artifactFilePath?: string;
  catalogFilePath?: string;
  resultSummary?: Record<string, unknown>;
  config?: Record<string, unknown>;
}): Promise<number> => {
  const db = getResearchDb();
  const result = await db.run(
    `INSERT INTO sweep_runs (
       name, description, config_json, status,
       result_summary_json, artifact_file_path, catalog_file_path,
       started_at, completed_at, created_at, updated_at
     ) VALUES (?, ?, ?, 'done', ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
    [
      opts.name,
      opts.description ?? '',
      JSON.stringify(opts.config ?? {}),
      JSON.stringify(opts.resultSummary ?? {}),
      opts.artifactFilePath ?? null,
      opts.catalogFilePath ?? null,
    ]
  );
  const id = result?.lastID;
  if (!id) {
    throw new Error('Failed to register sweep run');
  }
  logger.info(`Sweep run registered: #${id} "${opts.name}"`);
  return id;
};

/**
 * Bulk import sweep candidates as strategy_profiles.
 * Deduplicates by (sweep_run_id, base_symbol, quote_symbol, interval, strategy_type).
 */
export const importSweepCandidates = async (
  sweepRunId: number,
  candidates: Array<{
    name: string;
    strategy_type: string;
    market_mode: string;
    base_symbol: string;
    quote_symbol?: string;
    interval: string;
    config: Record<string, unknown>;
    metrics?: Record<string, unknown>;
  }>
): Promise<{ imported: number; skipped: number }> => {
  const db = getResearchDb();
  let imported = 0;
  let skipped = 0;

  for (const c of candidates) {
    const configHash = crypto.createHash('sha256').update(JSON.stringify(c.config)).digest('hex').slice(0, 16);
    const name = c.name || `${c.base_symbol}${c.quote_symbol ? '/' + c.quote_symbol : ''} ${c.strategy_type} ${c.interval}`;

    try {
      await db.run(
        `INSERT OR IGNORE INTO strategy_profiles (
           name, origin, strategy_type, market_mode,
           base_symbol, quote_symbol, interval,
           config_json, metrics_summary_json, sweep_run_id,
           tags_json, status, created_at, updated_at
         ) VALUES (?, 'sweep_candidate', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [
          `${name}-${configHash}`,
          c.strategy_type,
          c.market_mode,
          c.base_symbol,
          c.quote_symbol ?? null,
          c.interval,
          JSON.stringify(c.config),
          JSON.stringify(c.metrics ?? {}),
          sweepRunId,
          '[]',
        ]
      );
      imported++;
    } catch {
      skipped++;
    }
  }

  logger.info(`Sweep #${sweepRunId} import: ${imported} imported, ${skipped} skipped`);
  return { imported, skipped };
};

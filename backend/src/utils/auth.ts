import bcrypt from 'bcrypt';
import { createHash, randomBytes } from 'crypto';
import fs from 'fs';
import path from 'path';
import { db } from './database';

type ProductMode = 'strategy_client' | 'algofund_client' | 'copytrading_client';

type SessionRequestMeta = {
  ip?: string;
  userAgent?: string;
};

type ClientAuthUser = {
  id: number;
  email: string;
  fullName: string;
  preferredLanguage: string;
  onboardingCompletedAt: string | null;
  tenantId: number;
  tenantSlug: string;
  tenantDisplayName: string;
  tenantStatus: string;
  productMode: ProductMode;
};

type ClientUserWithTenantRow = {
  user_id: number;
  tenant_id: number;
  email: string;
  full_name: string;
  preferred_language: string;
  onboarding_completed_at: string | null;
  user_status: string;
  tenant_slug: string;
  tenant_display_name: string;
  tenant_status: string;
  product_mode: ProductMode;
};

type ClientSessionRow = {
  session_id: string;
  token_hash: string;
  expires_at: string;
  revoked_at: string | null;
} & ClientUserWithTenantRow;

type ClientSessionContext = {
  sessionId: string;
  tokenHash: string;
  expiresAt: string;
  token: string;
  user: ClientAuthUser;
};

type ClientAuthPayload = {
  token: string;
  expiresAt: string;
  workspaceRoute: string;
  user: ClientAuthUser;
};

type ClientRegistrationInput = {
  email: string;
  password: string;
  fullName?: string;
  companyName?: string;
  preferredLanguage?: string;
  productMode?: string;
};

type ClientLoginInput = {
  email: string;
  password: string;
};

type ClientMagicLinkResult = {
  token: string;
  expiresAt: string;
  loginUrl: string;
  tenantId: number;
  userId: number;
};

type StoredPasswordState = {
  passwordHash: string;
  updatedAt: string;
};

const isBcryptHash = (value: string): boolean => /^\$2[aby]\$\d{2}\$/.test(String(value || ''));

const resolvePasswordStateFile = (): string => {
  const raw = String(process.env.PASSWORD_STATE_FILE || '').trim();
  if (raw) {
    return raw;
  }

  // backend service runs from <APP_DIR>/backend, store state nearby by default.
  return path.resolve(process.cwd(), '.auth-password.json');
};

const PASSWORD_STATE_FILE = resolvePasswordStateFile();

const DEFAULT_CLIENT_SESSION_DAYS = 30;
const DEFAULT_STRATEGY_PLAN_CODE = 'strategy_20';
const DEFAULT_ALGOFUND_PLAN_CODE = 'algofund_20';
const DEFAULT_COPYTRADING_PLAN_CODE = 'copytrading_100';

const getClientSessionTtlMs = (): number => {
  const envValue = Number(process.env.CLIENT_SESSION_TTL_DAYS || DEFAULT_CLIENT_SESSION_DAYS);
  const days = Number.isFinite(envValue) && envValue >= 1
    ? Math.floor(envValue)
    : DEFAULT_CLIENT_SESSION_DAYS;

  return days * 24 * 60 * 60 * 1000;
};

const normalizeEmail = (value: unknown): string => String(value || '').trim().toLowerCase();

const normalizeProductMode = (value: unknown): ProductMode => {
  const raw = String(value || '').trim().toLowerCase();
  if (raw === 'algofund' || raw === 'algofund_client') {
    return 'algofund_client';
  }
  if (raw === 'copytrading' || raw === 'copytrading_client') {
    return 'copytrading_client';
  }
  return 'strategy_client';
};

const isValidEmail = (value: string): boolean => {
  if (!value || value.length > 190) {
    return false;
  }
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
};

const normalizeLanguage = (value: unknown): string => {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'ru' || text === 'tr') {
    return text;
  }
  return 'en';
};

const normalizeDisplayName = (value: unknown, fallback: string): string => {
  const text = String(value || '').trim();
  if (!text) {
    return fallback;
  }
  return text.slice(0, 80);
};

const createSlug = (value: string): string => {
  const base = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

  return base || 'client';
};

const hashSessionToken = (token: string): string => createHash('sha256').update(token).digest('hex');

const getBearerToken = (req: any): string => {
  const header = String(req?.headers?.authorization || '').trim();
  if (!header.toLowerCase().startsWith('bearer ')) {
    return '';
  }
  return header.slice(7).trim();
};

const buildClientAuthUser = (row: ClientUserWithTenantRow): ClientAuthUser => {
  return {
    id: Number(row.user_id),
    email: String(row.email || '').toLowerCase(),
    fullName: String(row.full_name || ''),
    preferredLanguage: String(row.preferred_language || 'en') || 'en',
    onboardingCompletedAt: row.onboarding_completed_at || null,
    tenantId: Number(row.tenant_id),
    tenantSlug: String(row.tenant_slug || ''),
    tenantDisplayName: String(row.tenant_display_name || ''),
    tenantStatus: String(row.tenant_status || 'active') || 'active',
    productMode: row.product_mode,
  };
};

const fetchClientUserById = async (userId: number): Promise<ClientUserWithTenantRow | null> => {
  const row = await db.get(
    `SELECT
       cu.id AS user_id,
       cu.tenant_id,
       cu.email,
       cu.full_name,
       cu.preferred_language,
       cu.onboarding_completed_at,
       cu.status AS user_status,
       t.slug AS tenant_slug,
       t.display_name AS tenant_display_name,
       t.status AS tenant_status,
       t.product_mode
     FROM client_users cu
     JOIN tenants t ON t.id = cu.tenant_id
     WHERE cu.id = ?
     LIMIT 1`,
    [userId]
  );

  return (row || null) as ClientUserWithTenantRow | null;
};

const fetchClientUserByEmail = async (email: string): Promise<(ClientUserWithTenantRow & { password_hash: string }) | null> => {
  const row = await db.get(
    `SELECT
       cu.id AS user_id,
       cu.tenant_id,
       cu.email,
       cu.password_hash,
       cu.full_name,
       cu.preferred_language,
       cu.onboarding_completed_at,
       cu.status AS user_status,
       t.slug AS tenant_slug,
       t.display_name AS tenant_display_name,
       t.status AS tenant_status,
       t.product_mode
     FROM client_users cu
     JOIN tenants t ON t.id = cu.tenant_id
     WHERE lower(cu.email) = lower(?)
     LIMIT 1`,
    [email]
  );

  return (row || null) as (ClientUserWithTenantRow & { password_hash: string }) | null;
};

const fetchPrimaryClientUserByTenantId = async (tenantId: number): Promise<ClientUserWithTenantRow | null> => {
  const row = await db.get(
    `SELECT
       cu.id AS user_id,
       cu.tenant_id,
       cu.email,
       cu.full_name,
       cu.preferred_language,
       cu.onboarding_completed_at,
       cu.status AS user_status,
       t.slug AS tenant_slug,
       t.display_name AS tenant_display_name,
       t.status AS tenant_status,
       t.product_mode
     FROM client_users cu
     JOIN tenants t ON t.id = cu.tenant_id
     WHERE cu.tenant_id = ?
       AND cu.status = 'active'
     ORDER BY cu.id ASC
     LIMIT 1`,
    [tenantId]
  );

  return (row || null) as ClientUserWithTenantRow | null;
};

const ensureUniqueTenantSlug = async (baseSlug: string): Promise<string> => {
  const normalizedBase = createSlug(baseSlug);
  let slug = normalizedBase;
  let suffix = 2;

  while (true) {
    const exists = await db.get('SELECT id FROM tenants WHERE slug = ? LIMIT 1', [slug]);
    if (!exists) {
      return slug;
    }
    slug = `${normalizedBase}-${suffix}`;
    suffix += 1;
  }
};

const ensureRegistrationPlanId = async (productMode: ProductMode): Promise<number> => {
  const preferredCode = productMode === 'strategy_client'
    ? DEFAULT_STRATEGY_PLAN_CODE
    : productMode === 'copytrading_client'
      ? DEFAULT_COPYTRADING_PLAN_CODE
      : DEFAULT_ALGOFUND_PLAN_CODE;

  let row = await db.get(
    'SELECT id FROM plans WHERE code = ? AND product_mode = ? AND is_active = 1 LIMIT 1',
    [preferredCode, productMode]
  );

  if (row?.id) {
    return Number(row.id);
  }

  row = await db.get(
    'SELECT id FROM plans WHERE product_mode = ? AND is_active = 1 ORDER BY price_usdt ASC, id ASC LIMIT 1',
    [productMode]
  );

  if (row?.id) {
    return Number(row.id);
  }

  const isStrategy = productMode === 'strategy_client';
  const fallbackCode = isStrategy ? 'selfreg_strategy_starter' : 'selfreg_algofund_starter';
  const fallbackTitle = isStrategy ? 'Strategy Client Starter' : 'Algofund Starter';
  const features = isStrategy
    ? { settings: true, apiKeyUpdate: false, monitoring: true, backtest: true, startStopRequests: false }
    : { settings: true, apiKeyUpdate: false, monitoring: true, backtest: true, startStopRequests: true };

  await db.run(
    `INSERT INTO plans (
       code,
       title,
       product_mode,
       price_usdt,
       max_deposit_total,
       risk_cap_max,
       max_strategies_total,
       allow_ts_start_stop_requests,
       features_json,
       is_active,
       created_at,
       updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(code) DO NOTHING`,
    [
      fallbackCode,
      fallbackTitle,
      productMode,
      isStrategy ? 20 : 20,
      isStrategy ? 1000 : 1000,
      isStrategy ? 0 : 1,
      isStrategy ? 3 : 0,
      isStrategy ? 0 : 1,
      JSON.stringify(features),
    ]
  );

  const created = await db.get('SELECT id FROM plans WHERE code = ? LIMIT 1', [fallbackCode]);
  if (!created?.id) {
    throw new Error('Unable to create default registration plan');
  }

  return Number(created.id);
};

const ensureTenantProfile = async (tenantId: number, productMode: ProductMode): Promise<void> => {
  if (productMode === 'strategy_client') {
    await db.run(
      `INSERT INTO strategy_client_profiles (
         tenant_id,
         selected_offer_ids_json,
         risk_level,
         trade_frequency_level,
         requested_enabled,
         actual_enabled,
         assigned_api_key_name,
         latest_preview_json,
         created_at,
         updated_at
       ) VALUES (?, '[]', 'medium', 'medium', 0, 0, '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(tenant_id) DO NOTHING`,
      [tenantId]
    );
    return;
  }

  await db.run(
    `INSERT INTO algofund_profiles (
       tenant_id,
       risk_multiplier,
       requested_enabled,
       actual_enabled,
       assigned_api_key_name,
       published_system_name,
       latest_preview_json,
       created_at,
       updated_at
     ) VALUES (?, 1, 0, 0, '', '', '{}', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT(tenant_id) DO NOTHING`,
    [tenantId]
  );
};

const createClientSession = async (user: ClientUserWithTenantRow, requestMeta?: SessionRequestMeta): Promise<ClientAuthPayload> => {
  const sessionId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const expiresAt = new Date(Date.now() + getClientSessionTtlMs()).toISOString();

  await db.run(
    `INSERT INTO client_sessions (
       id,
       user_id,
       token_hash,
       expires_at,
       revoked_at,
       last_seen_at,
       ip,
       user_agent,
       created_at
     ) VALUES (?, ?, ?, ?, NULL, CURRENT_TIMESTAMP, ?, ?, CURRENT_TIMESTAMP)`,
    [
      sessionId,
      Number(user.user_id),
      tokenHash,
      expiresAt,
      String(requestMeta?.ip || ''),
      String(requestMeta?.userAgent || '').slice(0, 255),
    ]
  );

  await db.run(
    `UPDATE client_users
     SET last_login_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [Number(user.user_id)]
  );

  return {
    token,
    expiresAt,
    workspaceRoute: '/cabinet',
    user: buildClientAuthUser(user),
  };
};

const readPasswordStateHash = (): string => {
  try {
    if (!fs.existsSync(PASSWORD_STATE_FILE)) {
      return '';
    }

    const parsed = JSON.parse(fs.readFileSync(PASSWORD_STATE_FILE, 'utf8')) as StoredPasswordState;
    const hash = String(parsed?.passwordHash || '').trim();
    return isBcryptHash(hash) ? hash : '';
  } catch {
    return '';
  }
};

const writePasswordStateHash = (passwordHash: string): void => {
  const payload: StoredPasswordState = {
    passwordHash,
    updatedAt: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(PASSWORD_STATE_FILE), { recursive: true });
  fs.writeFileSync(PASSWORD_STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
  fs.chmodSync(PASSWORD_STATE_FILE, 0o600);
};

const ENV_PASSWORD_HASH = String(process.env.PASSWORD_HASH || '').trim();
let currentPasswordHash = readPasswordStateHash() || (isBcryptHash(ENV_PASSWORD_HASH) ? ENV_PASSWORD_HASH : bcrypt.hashSync('defaultpassword', 10));

export const verifyDashboardPassword = (password: string): boolean => {
  return bcrypt.compareSync(password, currentPasswordHash);
};

export const setDashboardPassword = (nextPassword: string): void => {
  const password = String(nextPassword || '');
  if (password.length < 12) {
    throw new Error('Password must be at least 12 characters long');
  }

  const nextHash = bcrypt.hashSync(password, 10);
  currentPasswordHash = nextHash;
  process.env.PASSWORD_HASH = nextHash;
  writePasswordStateHash(nextHash);
};

export const registerClientUser = async (payload: ClientRegistrationInput, requestMeta?: SessionRequestMeta): Promise<ClientAuthPayload> => {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');

  if (!isValidEmail(email)) {
    throw new Error('Please provide a valid email');
  }

  if (password.length < 10) {
    throw new Error('Password must be at least 10 characters long');
  }

  const existingByEmail = await fetchClientUserByEmail(email);
  if (existingByEmail) {
    throw new Error('A user with this email already exists');
  }

  const productMode = normalizeProductMode(payload.productMode);
  const language = normalizeLanguage(payload.preferredLanguage);
  const fallbackName = email.split('@')[0] || 'Client';
  const fullName = normalizeDisplayName(payload.fullName, fallbackName);
  const companyName = normalizeDisplayName(payload.companyName, `${fullName} Workspace`);

  await db.exec('BEGIN');
  try {
    const tenantSlug = await ensureUniqueTenantSlug(companyName);
    const tenantInsert = await db.run(
      `INSERT INTO tenants (
         slug,
         display_name,
         product_mode,
         status,
         preferred_language,
         assigned_api_key_name,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, 'active', ?, '', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantSlug, companyName, productMode, language]
    );

    const tenantId = Number((tenantInsert as any).lastID || 0);
    if (!Number.isFinite(tenantId) || tenantId <= 0) {
      throw new Error('Unable to create tenant workspace');
    }

    const planId = await ensureRegistrationPlanId(productMode);
    await db.run(
      `INSERT INTO subscriptions (
         tenant_id,
         plan_id,
         status,
         started_at,
         notes,
         created_at,
         updated_at
       ) VALUES (?, ?, 'active', CURRENT_TIMESTAMP, 'self_registration', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, planId]
    );

    await ensureTenantProfile(tenantId, productMode);

    const passwordHash = await bcrypt.hash(password, 10);
    const userInsert = await db.run(
      `INSERT INTO client_users (
         tenant_id,
         email,
         password_hash,
         full_name,
         preferred_language,
         status,
         created_at,
         updated_at
       ) VALUES (?, ?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
      [tenantId, email, passwordHash, fullName, language]
    );

    const userId = Number((userInsert as any).lastID || 0);
    if (!Number.isFinite(userId) || userId <= 0) {
      throw new Error('Unable to create user account');
    }

    await db.exec('COMMIT');

    const createdUser = await fetchClientUserById(userId);
    if (!createdUser) {
      throw new Error('Unable to read created user account');
    }

    return createClientSession(createdUser, requestMeta);
  } catch (error) {
    await db.exec('ROLLBACK');
    throw error;
  }
};

export const loginClientUser = async (payload: ClientLoginInput, requestMeta?: SessionRequestMeta): Promise<ClientAuthPayload> => {
  const email = normalizeEmail(payload.email);
  const password = String(payload.password || '');

  if (!isValidEmail(email)) {
    throw new Error('Please provide a valid email');
  }

  if (!password) {
    throw new Error('Password is required');
  }

  const user = await fetchClientUserByEmail(email);
  if (!user) {
    throw new Error('Invalid email or password');
  }

  if (String(user.user_status || 'active') !== 'active') {
    throw new Error('User account is disabled');
  }

  if (String(user.tenant_status || 'active') !== 'active') {
    throw new Error('Workspace is not active');
  }

  const validPassword = await bcrypt.compare(password, String(user.password_hash || ''));
  if (!validPassword) {
    throw new Error('Invalid email or password');
  }

  return createClientSession(user, requestMeta);
};

export const createClientMagicLink = async (
  tenantId: number,
  requestMeta?: SessionRequestMeta,
  note?: string
): Promise<ClientMagicLinkResult> => {
  let user = await fetchPrimaryClientUserByTenantId(tenantId);
  if (!user) {
    // Auto-create a placeholder client user from tenant data so the magic link can be issued
    const tenant = await db.get(
      'SELECT id, slug, display_name, status FROM tenants WHERE id = ? LIMIT 1',
      [tenantId]
    ) as { id: number; slug: string; display_name: string; status: string } | undefined;
    if (!tenant) {
      throw new Error(`Tenant ${tenantId} not found`);
    }

    // First try to reactivate an existing tenant user, if any.
    const anyTenantUser = await db.get(
      'SELECT id FROM client_users WHERE tenant_id = ? ORDER BY id ASC LIMIT 1',
      [tenantId]
    ) as { id?: number } | undefined;

    if (anyTenantUser?.id) {
      const fallbackPasswordHash = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
      await db.run(
        `UPDATE client_users
         SET status = 'active',
             password_hash = CASE WHEN length(trim(coalesce(password_hash, ''))) = 0 THEN ? ELSE password_hash END,
             updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [fallbackPasswordHash, Number(anyTenantUser.id)]
      );
    } else {
      const placeholderEmail = `client+${tenant.id}-${tenant.slug}@algo.internal`;
      const fallbackPasswordHash = await bcrypt.hash(randomBytes(16).toString('hex'), 10);
      await db.run(
        `INSERT OR IGNORE INTO client_users (tenant_id, email, full_name, password_hash, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'active', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)`,
        [tenantId, placeholderEmail, String(tenant.display_name || tenant.slug), fallbackPasswordHash]
      ).catch(() => {/* duplicate — ignore */});
    }

    user = await fetchPrimaryClientUserByTenantId(tenantId);
    if (!user) {
      throw new Error(`Active client user not found for tenant ${tenantId} and auto-create failed`);
    }
  }

  if (String(user.tenant_status || 'active') !== 'active') {
    throw new Error('Workspace is not active');
  }

  const linkId = randomBytes(16).toString('hex');
  const token = randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(token);
  const ttlMin = Math.max(5, Number.parseInt(String(process.env.CLIENT_MAGIC_LINK_TTL_MIN || '1440'), 10) || 1440);
  const expiresAt = new Date(Date.now() + ttlMin * 60 * 1000).toISOString();
  const clientBaseUrl = String(process.env.CLIENT_BASE_URL || process.env.APP_BASE_URL || '').trim();
  const loginUrl = `${clientBaseUrl || ''}/client/login?token=${encodeURIComponent(token)}`;

  await db.run(
    `INSERT INTO client_magic_links (
       id,
       tenant_id,
       user_id,
       token_hash,
       expires_at,
       consumed_at,
       note,
       created_by,
       created_at
     ) VALUES (?, ?, ?, ?, ?, NULL, ?, 'platform_admin', CURRENT_TIMESTAMP)`,
    [
      linkId,
      Number(user.tenant_id),
      Number(user.user_id),
      tokenHash,
      expiresAt,
      String(note || '').slice(0, 500),
    ]
  );

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'platform_admin', 'client_magic_link_created', ?, CURRENT_TIMESTAMP)`,
    [Number(user.tenant_id), JSON.stringify({ userId: Number(user.user_id), expiresAt, ip: String(requestMeta?.ip || '') })]
  );

  return {
    token,
    expiresAt,
    loginUrl,
    tenantId: Number(user.tenant_id),
    userId: Number(user.user_id),
  };
};

export const loginClientByMagicToken = async (tokenRaw: string, requestMeta?: SessionRequestMeta): Promise<ClientAuthPayload> => {
  const token = String(tokenRaw || '').trim();
  if (!token) {
    throw new Error('Magic token is required');
  }

  const tokenHash = hashSessionToken(token);
  const row = await db.get(
    `SELECT
       cml.id,
       cml.tenant_id,
       cml.user_id,
       cml.expires_at,
       cml.consumed_at,
       cu.status AS user_status,
       t.status AS tenant_status
     FROM client_magic_links cml
     JOIN client_users cu ON cu.id = cml.user_id
     JOIN tenants t ON t.id = cml.tenant_id
     WHERE cml.token_hash = ?
     LIMIT 1`,
    [tokenHash]
  );

  if (!row) {
    throw new Error('Magic link is invalid');
  }

  if (row.consumed_at) {
    throw new Error('Magic link already used');
  }

  const expiresAtMs = Date.parse(String(row.expires_at || ''));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    throw new Error('Magic link expired');
  }

  if (String(row.user_status || 'active') !== 'active') {
    throw new Error('User account is disabled');
  }

  if (String(row.tenant_status || 'active') !== 'active') {
    throw new Error('Workspace is not active');
  }

  const user = await fetchClientUserById(Number(row.user_id));
  if (!user) {
    throw new Error('Client user not found');
  }

  await db.run(
    `UPDATE client_magic_links
     SET consumed_at = CURRENT_TIMESTAMP
     WHERE id = ? AND consumed_at IS NULL`,
    [String(row.id)]
  );

  await db.run(
    `INSERT INTO saas_audit_log (tenant_id, actor_mode, action, payload_json, created_at)
     VALUES (?, 'client_magic_link', 'client_magic_link_consumed', ?, CURRENT_TIMESTAMP)`,
    [Number(row.tenant_id), JSON.stringify({ userId: Number(row.user_id), ip: String(requestMeta?.ip || '') })]
  );

  return createClientSession(user, requestMeta);
};

export const getClientSessionFromToken = async (token: string, touch = true): Promise<ClientSessionContext | null> => {
  const normalized = String(token || '').trim();
  if (!normalized) {
    return null;
  }

  const tokenHash = hashSessionToken(normalized);
  const row = await db.get(
    `SELECT
       cs.id AS session_id,
       cs.token_hash,
       cs.expires_at,
       cs.revoked_at,
       cu.id AS user_id,
       cu.tenant_id,
       cu.email,
       cu.full_name,
       cu.preferred_language,
       cu.onboarding_completed_at,
       cu.status AS user_status,
       t.slug AS tenant_slug,
       t.display_name AS tenant_display_name,
       t.status AS tenant_status,
       t.product_mode
     FROM client_sessions cs
     JOIN client_users cu ON cu.id = cs.user_id
     JOIN tenants t ON t.id = cu.tenant_id
     WHERE cs.token_hash = ?
     LIMIT 1`,
    [tokenHash]
  );

  if (!row) {
    return null;
  }

  const session = row as ClientSessionRow;

  if (session.revoked_at) {
    return null;
  }

  const expiresAtMs = Date.parse(String(session.expires_at || ''));
  if (!Number.isFinite(expiresAtMs) || expiresAtMs <= Date.now()) {
    await db.run(
      `UPDATE client_sessions
       SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
       WHERE id = ?`,
      [String(session.session_id)]
    );
    return null;
  }

  if (String(session.user_status || 'active') !== 'active') {
    return null;
  }

  if (String(session.tenant_status || 'active') !== 'active') {
    return null;
  }

  if (touch) {
    await db.run(
      `UPDATE client_sessions
       SET last_seen_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
      [String(session.session_id)]
    );
  }

  return {
    sessionId: String(session.session_id),
    tokenHash,
    expiresAt: String(session.expires_at),
    token: normalized,
    user: buildClientAuthUser(session),
  };
};

export const getClientSessionFromRequest = async (req: any, touch = true): Promise<ClientSessionContext | null> => {
  const token = getBearerToken(req);
  if (!token) {
    return null;
  }
  return getClientSessionFromToken(token, touch);
};

export const revokeClientSession = async (token: string): Promise<void> => {
  const normalized = String(token || '').trim();
  if (!normalized) {
    return;
  }

  await db.run(
    `UPDATE client_sessions
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE token_hash = ?`,
    [hashSessionToken(normalized)]
  );
};

export const completeClientOnboarding = async (userId: number): Promise<void> => {
  await db.run(
    `UPDATE client_users
     SET onboarding_completed_at = COALESCE(onboarding_completed_at, CURRENT_TIMESTAMP),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = ?`,
    [userId]
  );
};

export const authenticateClient = async (req: any, res: any, next: any) => {
  try {
    const session = await getClientSessionFromRequest(req, true);
    if (!session) {
      return res.status(401).json({ error: 'Unauthorized client session' });
    }

    req.clientAuth = session;
    next();
  } catch (error) {
    const err = error as Error;
    return res.status(401).json({ error: err.message || 'Unauthorized client session' });
  }
};

export const getClientAuthPayloadFromSession = (session: ClientSessionContext): ClientAuthPayload => {
  return {
    token: session.token,
    expiresAt: session.expiresAt,
    workspaceRoute: '/cabinet',
    user: session.user,
  };
};

export const authenticate = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const password = authHeader.substring(7);
  if (!verifyDashboardPassword(password)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
};

/**
 * Phase 6 incremental RBAC guard.
 *
 * Backward-compatible behavior:
 * - If ADMIN_PLATFORM_TOKEN is not configured, falls back to existing dashboard password auth.
 * - If ADMIN_PLATFORM_TOKEN is configured, request must provide this token in Authorization Bearer.
 */
export const requirePlatformAdmin = (req: any, res: any, next: any) => {
  const platformToken = String(process.env.ADMIN_PLATFORM_TOKEN || '').trim();
  if (!platformToken) {
    return authenticate(req, res, next);
  }

  const authHeader = String(req?.headers?.authorization || '').trim();
  if (!authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const token = authHeader.slice(7).trim();
  if (!token || token !== platformToken) {
    return res.status(403).json({ error: 'Forbidden: platform_admin required' });
  }

  req.adminAuth = {
    role: 'platform_admin',
    authMode: 'platform_token',
  };

  next();
};
/**
 * Shared helpers for API route modules.
 * Extracted from routes.ts (move-only refactor).
 */

export const toOptionalNumber = (value: unknown): number | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : undefined;
};

export const toOptionalBool = (value: unknown): boolean | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  return undefined;
};

export const isLevel3 = (value: unknown): value is 'low' | 'medium' | 'high' => {
  return value === 'low' || value === 'medium' || value === 'high';
};

export const resolveClientAuthErrorStatus = (message: string): number => {
  const normalized = String(message || '').toLowerCase();

  if (normalized.includes('invalid email or password')) {
    return 401;
  }

  if (normalized.includes('disabled') || normalized.includes('not active')) {
    return 403;
  }

  if (normalized.includes('valid email') || normalized.includes('cabinet login') || normalized.includes('already exists') || normalized.includes('password') || normalized.includes('risk disclosure') || normalized.includes('name or nick')) {
    return 400;
  }

  return 500;
};

export const resolveClientWorkspaceErrorStatus = (message: string): number => {
  const normalized = String(message || '').toLowerCase();

  if (normalized.includes('unauthorized client session')) {
    return 401;
  }
  if (normalized.includes('not owned by current tenant')) {
    return 403;
  }
  if (normalized.includes('not found')) {
    return 404;
  }
  if (
    normalized.includes('already assigned')
    || normalized.includes('already used')
    || normalized.includes('already occupied')
    || normalized.includes('already exists')
    || normalized.includes('assign another key first')
    || normalized.includes('one key = one client')
    || normalized.includes('нельзя использовать один ключ')
    || normalized.includes('ключ занят')
    || normalized.includes('already assigned api key')
    || normalized.includes('currently assigned api key')
  ) {
    return 409;
  }
  if (
    normalized.includes('required')
    || normalized.includes('invalid')
    || normalized.includes('must be')
    || normalized.includes('unknown offers')
    || normalized.includes('сначала')
    || normalized.includes('нельзя включить')
    || normalized.includes('должен быть отдельным')
    || normalized.includes('лимит тарифа')
  ) {
    return 400;
  }

  return 500;
};

export const exchangeRequiresPassphrase = (exchange: string): boolean => {
  const normalized = String(exchange || '').trim().toLowerCase();
  return normalized.includes('bitget') || normalized.includes('weex');
};

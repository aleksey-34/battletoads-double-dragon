import { randomInt } from 'crypto';
import { setDashboardPassword } from '../utils/auth';

type RecoveryTransport = 'telegram' | 'disabled';

type RecoveryCodeState = {
  code: string;
  expiresAtMs: number;
  attemptsLeft: number;
};

export type PasswordRecoveryStatus = {
  enabled: boolean;
  transport: RecoveryTransport;
  targetMasked: string;
  codeTtlMin: number;
  cooldownSec: number;
  message?: string;
};

export class PasswordRecoveryError extends Error {
  statusCode: number;

  constructor(message: string, statusCode: number = 400) {
    super(message);
    this.name = 'PasswordRecoveryError';
    this.statusCode = statusCode;
  }
}

const TELEGRAM_BOT_TOKEN = String(process.env.RECOVERY_TELEGRAM_BOT_TOKEN || '').trim();
const TELEGRAM_CHAT_ID = String(process.env.RECOVERY_TELEGRAM_CHAT_ID || '').trim();
const RECOVERY_CODE_TTL_MIN = Math.max(3, Number.parseInt(String(process.env.RECOVERY_CODE_TTL_MIN || '10'), 10) || 10);
const RECOVERY_COOLDOWN_SEC = Math.max(15, Number.parseInt(String(process.env.RECOVERY_COOLDOWN_SEC || '60'), 10) || 60);
const RECOVERY_MAX_ATTEMPTS = Math.max(1, Number.parseInt(String(process.env.RECOVERY_MAX_ATTEMPTS || '5'), 10) || 5);

let activeCode: RecoveryCodeState | null = null;
let cooldownUntilMs = 0;

const isTelegramConfigured = (): boolean => Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_CHAT_ID);

const maskTarget = (): string => {
  if (!TELEGRAM_CHAT_ID) {
    return '';
  }

  const chatId = TELEGRAM_CHAT_ID;
  const tail = chatId.slice(-4);
  return `telegram:${tail ? `***${tail}` : '***'}`;
};

const nowMs = (): number => Date.now();

const sendTelegramRecoveryCode = async (code: string, meta: { ip: string; userAgent: string }): Promise<void> => {
  const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
  const body = {
    chat_id: TELEGRAM_CHAT_ID,
    text: [
      'BTDD password recovery code',
      `Code: ${code}`,
      `Valid for: ${RECOVERY_CODE_TTL_MIN} min`,
      `IP: ${meta.ip || '-'}`,
      `UA: ${meta.userAgent || '-'}`,
      `Time (UTC): ${new Date().toISOString()}`,
    ].join('\n'),
    disable_web_page_preview: true,
  };

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Unknown error');
    throw new Error(`Telegram API error: ${response.status} ${errorText}`);
  }
};

export const getPasswordRecoveryStatus = (): PasswordRecoveryStatus => {
  if (isTelegramConfigured()) {
    return {
      enabled: true,
      transport: 'telegram',
      targetMasked: maskTarget(),
      codeTtlMin: RECOVERY_CODE_TTL_MIN,
      cooldownSec: RECOVERY_COOLDOWN_SEC,
    };
  }

  return {
    enabled: false,
    transport: 'disabled',
    targetMasked: '',
    codeTtlMin: RECOVERY_CODE_TTL_MIN,
    cooldownSec: RECOVERY_COOLDOWN_SEC,
    message: 'Recovery is not configured. Set RECOVERY_TELEGRAM_BOT_TOKEN and RECOVERY_TELEGRAM_CHAT_ID in backend env.',
  };
};

export const requestPasswordRecoveryCode = async (meta: { ip: string; userAgent: string }): Promise<{ sent: boolean }> => {
  if (!isTelegramConfigured()) {
    throw new PasswordRecoveryError('Password recovery is not configured on server', 400);
  }

  const now = nowMs();
  if (now < cooldownUntilMs) {
    const waitSec = Math.max(1, Math.ceil((cooldownUntilMs - now) / 1000));
    throw new PasswordRecoveryError(`Too many requests. Retry in ${waitSec} sec`, 429);
  }

  const code = String(randomInt(100000, 1000000));
  activeCode = {
    code,
    expiresAtMs: now + RECOVERY_CODE_TTL_MIN * 60 * 1000,
    attemptsLeft: RECOVERY_MAX_ATTEMPTS,
  };
  cooldownUntilMs = now + RECOVERY_COOLDOWN_SEC * 1000;

  try {
    await sendTelegramRecoveryCode(code, meta);
    return { sent: true };
  } catch (error: any) {
    // Reset temporary state if delivery failed.
    activeCode = null;
    cooldownUntilMs = 0;
    throw new PasswordRecoveryError(String(error?.message || 'Failed to send recovery code'), 502);
  }
};

export const resetPasswordWithRecoveryCode = async (codeRaw: string, newPasswordRaw: string): Promise<{ reset: boolean }> => {
  if (!activeCode) {
    throw new PasswordRecoveryError('Recovery code is missing. Request a new code first.', 400);
  }

  const code = String(codeRaw || '').trim();
  const newPassword = String(newPasswordRaw || '');

  const now = nowMs();
  if (now > activeCode.expiresAtMs) {
    activeCode = null;
    throw new PasswordRecoveryError('Recovery code expired. Request a new code.', 400);
  }

  if (!code) {
    throw new PasswordRecoveryError('Recovery code is required', 400);
  }

  if (!newPassword || newPassword.length < 12) {
    throw new PasswordRecoveryError('New password must be at least 12 characters long', 400);
  }

  if (code !== activeCode.code) {
    activeCode.attemptsLeft -= 1;
    if (activeCode.attemptsLeft <= 0) {
      activeCode = null;
      throw new PasswordRecoveryError('Recovery code failed too many times. Request a new code.', 400);
    }

    throw new PasswordRecoveryError(`Invalid recovery code. Attempts left: ${activeCode.attemptsLeft}`, 400);
  }

  setDashboardPassword(newPassword);
  activeCode = null;
  return { reset: true };
};

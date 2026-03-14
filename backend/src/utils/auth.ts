import bcrypt from 'bcrypt';
import fs from 'fs';
import path from 'path';

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
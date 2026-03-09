import bcrypt from 'bcrypt';

const PASSWORD_HASH = process.env.PASSWORD_HASH || bcrypt.hashSync('defaultpassword', 10); // Хэш пароля, установить в .env

export const authenticate = (req: any, res: any, next: any) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const password = authHeader.substring(7);
  if (!bcrypt.compareSync(password, PASSWORD_HASH)) {
    return res.status(401).json({ error: 'Invalid password' });
  }
  next();
};
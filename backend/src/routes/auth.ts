import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { pool } from '../db';
import { createSession, csrfToken, revokeSession, setSessionCookie, clearSessionCookie } from '../sessions';
import { requireAuth, AuthedRequest } from '../middleware/auth';
import { loginLimiter } from '../middleware/security';

const router = Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
const missingUserHash = bcrypt.hashSync('unusable-account-timing-placeholder', 10);

router.post('/login', loginLimiter(), async (req, res) => {
  try {
  const { username, password } = req.body ?? {};
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password || username.length > 128 || password.length > 1024) {
    res.status(400).json({ error: 'username and password required' });
    return;
  }
  const { rows } = await pool.query(
    'SELECT id, username, password, role FROM users WHERE username = $1',
    [username]
  );
  const user = rows[0];
  const ok = await bcrypt.compare(password, user?.password ?? missingUserHash);
  if (!user || !ok) {
    res.status(401).json({ error: 'Invalid credentials' });
    return;
  }
  const session = await createSession({
    sub: user.id,
    username: user.username,
    role: user.role,
  });
  setSessionCookie(req, res, session.token, session.expiresAt);
  res.json({ token: session.token, csrf: session.csrf, user: { id: user.id, username: user.username, role: user.role } });
  } catch { res.status(503).json({ error: 'Không thể đăng nhập lúc này. Vui lòng thử lại.' }); }
});

router.get('/session', requireAuth, (req: AuthedRequest, res) => {
  res.json({ user: { id: req.user!.sub, username: req.user!.username, role: req.user!.role }, csrf: csrfToken(req.sessionToken!) });
});

// Called by nginx auth_request for every playlist, segment, snapshot and sprite.
router.get('/media', requireAuth, (_req, res) => { res.sendStatus(204); });

router.post('/logout', requireAuth, async (req: AuthedRequest, res) => {
  try { await revokeSession(req.sessionToken!); clearSessionCookie(req, res); res.sendStatus(204); }
  catch { res.status(503).json({ error: 'Không thể thu hồi phiên. Vui lòng thử đăng xuất lại.' }); }
});

export default router;

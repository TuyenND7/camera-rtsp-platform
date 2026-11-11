const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../dist/db');
const { signToken } = require('../dist/auth');
const { config } = require('../dist/config');
const { tokenHash } = require('../dist/sessions');
const { requireAuth, requireAdmin } = require('../dist/middleware/auth');
const { browserRequestGuard, loginLimiter } = require('../dist/middleware/security');
const authRoutes = require('../dist/routes/auth').default;
const { setSessionCookie } = require('../dist/sessions');

let server, origin, originalQuery, unavailable = false;
let user = { id: 1, username: 'security-test', password: bcrypt.hashSync('test-password-long-enough', 10), role: 'admin' };
const sessions = new Map();
before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, values = []) => {
    if (unavailable) throw new Error('database unavailable');
    if (sql.startsWith('DELETE FROM auth_sessions WHERE expires_at')) {
      for (const [key, session] of sessions) if (+session.expiry <= Date.now()) sessions.delete(key);
      return { rows: [] };
    }
    if (sql.startsWith('INSERT INTO auth_sessions')) { sessions.set(values[0], { userId: values[1], expiry: values[2] }); return { rows: [] }; }
    if (sql.startsWith('DELETE FROM auth_sessions WHERE token_hash')) { sessions.delete(values[0]); return { rows: [] }; }
    if (sql.startsWith('SELECT u.id')) {
      const session = sessions.get(values[0]);
      return { rows: session && session.userId === values[1] && +session.expiry > Date.now() ? [user] : [] };
    }
    if (sql.startsWith('SELECT id, username, password, role FROM users')) return { rows: values[0] === user.username ? [user] : [] };
    throw new Error(`Unexpected query: ${sql}`);
  };
  const app = express();
  app.use(browserRequestGuard, express.json());
  app.use('/api/auth', authRoutes);
  app.post('/write', requireAuth, (_req, res) => res.sendStatus(204));
  app.get('/admin', requireAuth, requireAdmin, (_req, res) => res.sendStatus(204));
  let clock = 0;
  app.post('/limited', loginLimiter(2, 1000, () => clock), (_req, res) => res.sendStatus(204));
  app.get('/advance-clock', (_req, res) => { clock += 1001; res.sendStatus(204); });
  server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { pool.query = originalQuery; await new Promise((resolve) => server.close(resolve)); });

const request = (url, options = {}) => fetch(origin + url, options);
async function login() {
  const response = await request('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'CameraStation' }, body: JSON.stringify({ username: user.username, password: 'test-password-long-enough' }) });
  assert.equal(response.status, 200);
  const data = await response.json();
  return { ...data, cookie: response.headers.get('set-cookie').split(';')[0], cookieHeader: response.headers.get('set-cookie') };
}

test('anonymous media and URL tokens do not authorize a request', async () => {
  assert.equal((await request('/api/auth/media')).status, 401);
  assert.equal((await request('/api/auth/media?token=anything')).status, 401);
  assert.equal((await request('/api/auth/media', { headers: { Authorization: 'Bearer invalid.token.value' } })).status, 401);
});

test('cross-origin and form-style login requests are rejected', async () => {
  assert.equal((await request('/api/auth/login', { method: 'POST' })).status, 403);
  assert.equal((await request('/api/auth/login', { method: 'POST', headers: { Origin: 'https://untrusted.example', 'X-Requested-With': 'CameraStation' } })).status, 403);
  assert.equal((await request('/api/auth/session', { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
});

test('HTTPS sessions set Secure in addition to HttpOnly and SameSite', () => {
  let options;
  setSessionCookie({ secure: true }, { cookie: (_name, _token, value) => { options = value; } }, 'not-logged-or-persisted', new Date(Date.now() + 60_000));
  assert.equal(options.secure, true);
  assert.equal(options.httpOnly, true);
  assert.equal(options.sameSite, 'strict');
  assert.equal(options.path, '/');
});

test('HttpOnly cookie authorizes media; ambiguous cookies and conflicting bearer fail closed', async () => {
  const session = await login();
  assert.match(session.cookieHeader, /HttpOnly/i);
  assert.match(session.cookieHeader, /SameSite=Strict/i);
  assert.match(session.cookieHeader, /Path=\//i);
  assert.equal((await request('/api/auth/media', { headers: { Cookie: session.cookie } })).status, 204);
  assert.equal((await request('/api/auth/media', { headers: { Cookie: `${session.cookie}; ${session.cookie}` } })).status, 401);
  assert.equal((await request('/api/auth/media', { headers: { Cookie: session.cookie, Authorization: 'Bearer invalid' } })).status, 401);
  const info = await (await request('/api/auth/session', { headers: { Cookie: session.cookie } })).json();
  assert.equal(info.csrf, session.csrf);
  assert.equal(info.user.username, user.username);
});

test('cookie writes require the correct session-bound CSRF token', async () => {
  const session = await login();
  const other = await login();
  const headers = { Cookie: session.cookie, 'X-Requested-With': 'CameraStation' };
  assert.equal((await request('/write', { method: 'POST', headers })).status, 403);
  assert.equal((await request('/write', { method: 'POST', headers: { ...headers, 'X-CSRF-Token': other.csrf } })).status, 403);
  assert.equal((await request('/write', { method: 'POST', headers: { ...headers, Origin: origin, 'X-CSRF-Token': session.csrf } })).status, 204);
});

test('logout revokes both copied cookies and API bearer credentials', async () => {
  const session = await login();
  const response = await request('/api/auth/logout', { method: 'POST', headers: { Cookie: session.cookie, 'X-Requested-With': 'CameraStation', 'X-CSRF-Token': session.csrf } });
  assert.equal(response.status, 204);
  assert.match(response.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/i);
  assert.equal((await request('/api/auth/media', { headers: { Cookie: session.cookie } })).status, 401);
  assert.equal((await request('/api/auth/session', { headers: { Authorization: `Bearer ${session.token}` } })).status, 401);
});

test('unregistered, expired and unsigned JWTs cannot authorize media', async () => {
  const claims = { sub: user.id, username: user.username, role: user.role };
  const unregistered = signToken(claims);
  const expired = jwt.sign(claims, config.jwtSecret, { algorithm: 'HS256', issuer: 'camera-station', audience: 'camera-station', jwtid: 'expired-test', expiresIn: -1 });
  const unsigned = jwt.sign(claims, '', { algorithm: 'none' });
  sessions.set(tokenHash(expired), { userId: user.id, expiry: new Date(Date.now() + 60_000) });
  for (const token of [unregistered, expired, unsigned]) assert.equal((await request('/api/auth/media', { headers: { Authorization: `Bearer ${token}` } })).status, 401);
  const registered = await login();
  sessions.get(tokenHash(registered.token)).expiry = new Date(0);
  assert.equal((await request('/api/auth/media', { headers: { Cookie: registered.cookie } })).status, 401);
});

test('database failures deny access and current DB role controls administration', async () => {
  const session = await login();
  unavailable = true;
  assert.equal((await request('/api/auth/media', { headers: { Cookie: session.cookie } })).status, 503);
  unavailable = false;
  user.role = 'viewer';
  assert.equal((await request('/admin', { headers: { Cookie: session.cookie } })).status, 403);
  user.role = 'admin';
  assert.equal((await request('/admin', { headers: { Cookie: session.cookie } })).status, 204);
});

test('login limiter rejects a burst and allows requests after the window expires', async () => {
  const options = { method: 'POST', headers: { 'X-Requested-With': 'CameraStation' } };
  assert.equal((await request('/limited', options)).status, 204);
  assert.equal((await request('/limited', options)).status, 204);
  const blocked = await request('/limited', options);
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  await request('/advance-clock');
  assert.equal((await request('/limited', options)).status, 204);
});

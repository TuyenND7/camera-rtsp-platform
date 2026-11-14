const { test, before, after } = require('node:test'), assert = require('node:assert/strict'), http = require('node:http'), express = require('express');
const { pool } = require('../dist/db'), { signToken } = require('../dist/auth'), { tokenHash, csrfToken } = require('../dist/sessions');
const { browserRequestGuard, jsonRequestError } = require('../dist/middleware/security'), { tendaAccount } = require('../dist/account/tenda'), routes = require('../dist/routes/settings').default;
const admin = signToken({ sub: 1, username: 'owner', role: 'admin' }), viewer = signToken({ sub: 2, username: 'viewer', role: 'viewer' });
const sessions = new Map([[tokenHash(admin), { id: 1, username: 'owner', role: 'admin' }], [tokenHash(viewer), { id: 2, username: 'viewer', role: 'viewer' }]]);
let server, origin, query, login, calls = 0;
before(async () => {
  query = pool.query; pool.query = async (_sql, values) => ({ rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] });
  login = tendaAccount.login; tendaAccount.login = async (_input, _signal, authorized) => { assert(await authorized()); calls++; };
  const app = express(); app.set('trust proxy', 1); app.use('/api', browserRequestGuard, express.json({ limit: '16kb' })); app.use(jsonRequestError); app.use('/api/settings', routes);
  server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); origin = `http://127.0.0.1:${server.address().port}`;
});
after(async () => { pool.query = query; tendaAccount.login = login; await new Promise(resolve => server.close(resolve)); await pool.end(); });
function request({ token = admin, method = 'POST', headers = {}, body = { account: 'a@example.com', password: 'secret' } } = {}) {
  return fetch(origin + '/api/settings/tenda' + (method === 'POST' ? '/login' : ''), { method, headers: { ...(token ? { Authorization: 'Bearer ' + token } : {}), 'Content-Type': 'application/json', 'X-Forwarded-Proto': 'https', ...headers }, ...(method === 'GET' ? {} : { body: JSON.stringify(body) }) });
}
test('requires administrator, HTTPS, same origin and cookie CSRF before any Tenda request', async () => {
  assert.equal((await request({ token: null })).status, 403);
  assert.equal((await request({ token: null, method: 'GET' })).status, 401);
  assert.equal((await request({ token: viewer })).status, 403);
  assert.equal((await request({ headers: { 'X-Forwarded-Proto': 'http' } })).status, 400);
  assert.equal((await request({ headers: { Origin: 'https://evil.example' } })).status, 403);
  const cookie = { Cookie: 'camera_session=' + admin, 'X-Requested-With': 'CameraStation' };
  assert.equal((await request({ token: null, headers: cookie })).status, 403);
  assert.equal(calls, 0);
  assert.equal((await request({ token: null, headers: { ...cookie, 'X-CSRF-Token': csrfToken(admin) } })).status, 200);
  assert.equal(calls, 1);
});
test('invalid input and bounded attempts cannot reach provider', async () => {
  assert.equal((await request({ body: { account: 'not-an-account', password: 'secret' } })).status, 400);
  await request(); await request(); // Together with the preceding HTTP and valid request, exhaust the five attempts.
  assert.equal((await request()).status, 429);
  assert.equal(calls, 3);
});
test('malformed JSON never returns parser diagnostics containing submitted credentials', async () => {
  const response = await fetch(origin + '/api/settings/tenda/login', { method: 'POST', headers: { Authorization: 'Bearer ' + admin, 'Content-Type': 'application/json' }, body: '{"password":"fixture-private-secret", invalid' });
  assert.equal(response.status, 400); assert(!((await response.text()).includes('fixture-private-secret')));
});

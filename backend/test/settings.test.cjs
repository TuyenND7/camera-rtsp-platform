const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const express = require('express');
const { pool } = require('../dist/db');
const { config } = require('../dist/config');
const { signToken } = require('../dist/auth');
const { tokenHash, csrfToken } = require('../dist/sessions');
const { browserRequestGuard } = require('../dist/middleware/security');
const { currentSettings, saveSettings, loadSettings } = require('../dist/settings');
const settingsRoutes = require('../dist/routes/settings').default;
const { startRetentionJob } = require('../dist/stream/retention');

const originalConfig = { ...config };
const initial = { public_base_url: '', storage_label: 'Test storage', record_retention_hours: 0,
  cleanup_threshold_percent: 90, cleanup_target_percent: 85, cleanup_interval_minutes: 10, alarm_duration_seconds: 30 };
let server, origin, originalQuery, stored = null, writes = [], failWrite = false, delayWrite = false;
const admin = signToken({ sub: 1, username: 'admin-test', role: 'admin' });
const viewer = signToken({ sub: 2, username: 'viewer-test', role: 'viewer' });
const sessions = new Map([[tokenHash(admin), { id: 1, username: 'admin-test', role: 'admin' }], [tokenHash(viewer), { id: 2, username: 'viewer-test', role: 'viewer' }]]);
before(async () => {
  originalQuery = pool.query;
  pool.query = async (sql, values = []) => {
    if (sql.startsWith('SELECT u.id')) return { rows: sessions.has(values[0]) ? [sessions.get(values[0])] : [] };
    if (sql.startsWith('SELECT value FROM application_settings')) return { rows: stored ? [{ value: JSON.parse(JSON.stringify(stored)) }] : [] };
    if (sql.startsWith('INSERT INTO application_settings')) {
      if (failWrite) throw new Error('simulated settings write failure');
      if (delayWrite) { delayWrite = false; await new Promise(r => setTimeout(r, 30)); }
      stored = JSON.parse(values[0]); writes.push({ value: stored, userId: values[1] });
      return { rows: [] };
    }
    throw new Error('Unexpected database operation');
  };
  const app = express(); app.use(browserRequestGuard, express.json()); app.use('/api/settings', settingsRoutes);
  server = http.createServer(app); await new Promise(r => server.listen(0, '127.0.0.1', r)); origin = `http://127.0.0.1:${server.address().port}`;
  await saveSettings(initial, 1);
});
after(async () => { pool.query = originalQuery; Object.assign(config, originalConfig); await new Promise(r => server.close(r)); });
const request = (method = 'GET', data, token = admin, headers = {}) => fetch(origin + '/api/settings', { method,
  headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers },
  ...(data !== undefined ? { body: JSON.stringify(data) } : {}) });

test('settings require a current administrator session for reads and writes', async () => {
  assert.equal((await request('GET', undefined, null)).status, 401);
  assert.equal((await request('GET', undefined, viewer)).status, 403);
  assert.equal((await request('PUT', initial, viewer)).status, 403);
  const r = await request(); assert.equal(r.status, 200); const data = await r.json();
  assert.deepEqual(Object.keys(data).sort(), ['record_timezone', 'settings', 'storage_root']);
  assert.ok(!JSON.stringify(data).includes(config.jwtSecret));
});

test('cross-origin settings writes and cookie writes without CSRF are rejected', async () => {
  assert.equal((await request('PUT', initial, admin, { Origin: 'https://untrusted.example' })).status, 403);
  const base = { Cookie: `camera_session=${admin}`, 'X-Requested-With': 'CameraStation', 'Content-Type': 'application/json' };
  assert.equal((await fetch(origin + '/api/settings', { method: 'PUT', headers: base, body: JSON.stringify(initial) })).status, 403);
  assert.equal((await fetch(origin + '/api/settings', { method: 'PUT', headers: { ...base, 'X-CSRF-Token': csrfToken(admin) }, body: JSON.stringify(initial) })).status, 200);
});

test('invalid cleanup policies, unexpected keys and credential URLs never reach persistence', async () => {
  const count = writes.length;
  const cases = [null, [], {}, { ...initial, cleanup_target_percent: 90 }, { ...initial, cleanup_threshold_percent: 100 },
    { ...initial, record_retention_hours: -1 }, { ...initial, cleanup_interval_minutes: 0 }, { ...initial, cleanup_interval_minutes: 1.5 },
    { ...initial, cleanup_threshold_percent: '90' }, { ...initial, storage_label: ' ' }, { ...initial, storage_label: 'x'.repeat(101) },
    { ...initial, public_base_url: 'javascript:alert(1)' }, { ...initial, public_base_url: 'http://user:password@camera.local' },
    { ...initial, storage_root: '/another-volume' }, { ...initial, jwtSecret: 'replacement-secret' }];
  for (const value of cases) assert.equal((await request('PUT', value)).status, 400);
  assert.equal(writes.length, count);
});

test('saved policy is normalized, audited and takes effect after a simulated restart', async () => {
  const next = { ...initial, public_base_url: 'http://camera.local:8081/live?ignored=yes', storage_label: '  Camera Documents  ', record_retention_hours: 72, cleanup_threshold_percent: 88, cleanup_target_percent: 80, cleanup_interval_minutes: 3 };
  const r = await request('PUT', next); assert.equal(r.status, 200); const value = (await r.json()).settings;
  assert.equal(value.public_base_url, 'http://camera.local:8081'); assert.equal(value.storage_label, 'Camera Documents');
  assert.equal(writes.at(-1).userId, 1); assert.deepEqual(currentSettings(), value);
  Object.assign(config, originalConfig); await loadSettings(); assert.deepEqual(currentSettings(), value);
});

test('a failed database write keeps the active policy intact and later writes still work', async () => {
  const before = currentSettings(); failWrite = true;
  assert.equal((await request('PUT', { ...before, storage_label: 'Must not apply' })).status, 503);
  assert.deepEqual(currentSettings(), before); failWrite = false;
  assert.equal((await request('PUT', initial)).status, 200); assert.deepEqual(currentSettings(), initial);
});

test('concurrent saves apply in order despite a delayed first database write', async () => {
  delayWrite = true;
  const a = saveSettings({ ...initial, storage_label: 'First' }, 1);
  const b = saveSettings({ ...initial, storage_label: 'Second' }, 1);
  await Promise.all([a, b]); assert.equal(currentSettings().storage_label, 'Second'); assert.equal(stored.storage_label, 'Second');
});
test('alarm duration presets persist, reload, reject unknown values and migrate older settings', async () => {
  for (const seconds of [0,10,15,30,60]) {
    const r=await request('PUT',{...initial,alarm_duration_seconds:seconds}); assert.equal(r.status,200);
    assert.equal((await r.json()).settings.alarm_duration_seconds,seconds); config.alarmDurationSeconds=99;
    await loadSettings(); assert.equal(currentSettings().alarm_duration_seconds,seconds);
  }
  const count=writes.length;
  for (const value of [-1,5,20,61,1.5,'30',false,null]) assert.equal((await request('PUT',{...initial,alarm_duration_seconds:value})).status,400);
  assert.equal(writes.length,count);
  await saveSettings({...initial,alarm_duration_seconds:0},1); const legacy={...initial}; delete legacy.alarm_duration_seconds;
  assert.equal((await request('PUT',legacy)).status,200); assert.equal(currentSettings().alarm_duration_seconds,0);
  stored={...initial}; delete stored.alarm_duration_seconds;
  await loadSettings(); assert.equal(currentSettings().alarm_duration_seconds,30); await saveSettings(initial,1);
});

test('retention reads an updated interval and policy without restarting or deleting current-day recordings', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-settings-'));
  const old = path.join(root, 'rec', '1', '20000101');
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: config.recordTimezone }).format(new Date()).replaceAll('-', '');
  const current = path.join(root, 'rec', '1', today);
  fs.mkdirSync(old, { recursive: true }); fs.mkdirSync(current, { recursive: true });
  fs.writeFileSync(path.join(old, 'sample.ts'), 'sample'); fs.writeFileSync(path.join(current, 'sample.ts'), 'sample');
  const oldTime = new Date(Date.now() - 7 * 86400000); fs.utimesSync(path.join(old, 'sample.ts'), oldTime, oldTime);
  const originalStatfs = fs.statfsSync, originalNow = Date.now; let clock = Date.now(), reads = 0, timer;
  const waitFor = async predicate => { for (let i = 0; i < 200; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 5)); } throw new Error('Retention did not complete'); };
  try {
    config.storageRoot = root; Date.now = () => clock;
    fs.statfsSync = () => { reads++; return { blocks: 1000, bsize: 1, bavail: 900 }; };
    await saveSettings(initial, 1); timer = startRetentionJob();
    await waitFor(() => reads >= 1); await new Promise(r => setImmediate(r));
    assert.ok(fs.existsSync(old));
    clock += 5 * 60000;
    timer._onTimeout(); await new Promise(r => setImmediate(r)); assert.equal(reads, 1);
    await saveSettings({ ...initial, record_retention_hours: 1, cleanup_interval_minutes: 1 }, 1);
    timer._onTimeout(); await waitFor(() => !fs.existsSync(old));
    assert.ok(fs.existsSync(current));
    await waitFor(() => fs.existsSync(path.join(root, 'cleanup-log.json')));
    const log = JSON.parse(fs.readFileSync(path.join(root, 'cleanup-log.json'), 'utf8')); assert.equal(log[0].reason, 'retention');
  } finally {
    if (timer) clearInterval(timer); Date.now = originalNow; fs.statfsSync = originalStatfs;
    config.storageRoot = originalConfig.storageRoot; fs.rmSync(root, { recursive: true, force: true }); await saveSettings(initial, 1);
  }
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { generateKeyPairSync, createHash, privateDecrypt, constants, randomUUID } = require('node:crypto');
const { TendaAccount, validateAccountInput } = require('../dist/account/tenda');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function fixture() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-account-'));
  fs.mkdirSync(path.join(base, 'account'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }); jwk.kid = createHash('sha256').update(`${jwk.n}.${jwk.e}`).digest('hex');
  const instance = randomUUID();
  const state = { version: 1, instance, updated_at: Date.now(), state: 'login_required', account_label: 'a***@example.com', public_key: jwk, accessToken: 'never-return-this-token' };
  function publish() { state.updated_at = Date.now(); fs.writeFileSync(path.join(base, 'status.json'), JSON.stringify({ instance, updated_at: Date.now() })); fs.writeFileSync(path.join(base, 'account-status.json'), JSON.stringify(state)); }
  publish(); const timer = setInterval(publish, 500);
  return { base, privateKey, state, publish, adapter: new TendaAccount(base), close() { clearInterval(timer); fs.rmSync(base, { recursive: true, force: true }); } };
}
async function job(f) { for (let n = 0; n < 100; n++) { const names = fs.readdirSync(path.join(f.base, 'account')); if (names.length) return path.join(f.base, 'account', names[0]); await delay(20); } throw Error('no command'); }
test('validates TDSEE account and UTF-8 password limits', () => {
  assert.deepEqual(validateAccountInput({ account: ' 0123456789 ', password: 'a ' }), { account: '0123456789', password: 'a ' });
  for (const body of [{}, { account: 'abc', password: 'x' }, { account: 'a@b.com', password: '' }, { account: 'a@b.com', password: 'ứ'.repeat(43) }, { account: 'a@b.com', password: '\0' }]) assert.throws(() => validateAccountInput(body));
});
test('status is a strict whitelist; expired or mismatched generations fail closed', () => {
  const f = fixture(); try {
    assert.equal(f.adapter.status().available, true); assert(!JSON.stringify(f.adapter.status()).includes('never-return')); assert(!JSON.stringify(f.adapter.status()).includes('public_key'));
    f.state.instance = randomUUID(); f.publish(); assert.equal(f.adapter.status().available, false);
  } finally { f.close(); }
});
test('a transient shared-file replacement reuses only its original freshness; malformed records revoke the cache', () => {
  const f = fixture(); try {
    assert(f.adapter.status().available);
    const file = path.join(f.base, 'account-status.json'), saved = file + '.saved';
    fs.renameSync(file, saved); assert(f.adapter.status().available); fs.renameSync(saved, file);
    fs.writeFileSync(file, 'invalid'); assert.equal(f.adapter.status().available, false);
    fs.unlinkSync(file); assert.equal(f.adapter.status().available, false);
    f.state.updated_at = Date.now() - 4000; fs.writeFileSync(file, JSON.stringify(f.state)); assert.equal(f.adapter.status().available, false);
  } finally { f.close(); }
});
test('IPC carries OAEP-SHA256 ciphertext and clears password references', async () => {
  const f = fixture(); try {
    const input = { account: 'a@example.com', password: 'fixture-secret-password' };
    const pending = f.adapter.login(input, new AbortController().signal, async () => true);
    const directory = await job(f); const text = fs.readFileSync(path.join(directory, 'command.json'), 'utf8');
    assert(!text.includes('fixture-secret-password')); assert.equal(input.password, '');
    const command = JSON.parse(text);
    assert.equal(privateDecrypt({ key: f.privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(command.password_ciphertext, 'base64')).toString(), 'fixture-secret-password');
    fs.writeFileSync(path.join(directory, 'result.json'), '{"ok":true}'); await pending;
  } finally { f.close(); }
});
test('revoked administrator sessions stop the native transaction', async () => {
  const f = fixture(); try {
    let authorized = true;
    const pending = f.adapter.login({ account: 'a@example.com', password: 'secret' }, new AbortController().signal, async () => authorized);
    const directory = await job(f); authorized = false;
    await assert.rejects(pending, error => error.status === 403);
    assert(fs.existsSync(path.join(directory, 'stop')));
  } finally { f.close(); }
});
test('cancelled requests stop IPC; provider credential rejection is 422, never web-session 401', async () => {
  const f = fixture(); try {
    const controller = new AbortController(); let pending = f.adapter.login({ account: 'a@example.com', password: 'secret' }, controller.signal, async () => true);
    let directory = await job(f); controller.abort(); await assert.rejects(pending); assert(fs.existsSync(path.join(directory, 'stop')));
    fs.rmSync(directory, { recursive: true });
    pending = f.adapter.login({ account: 'a@example.com', password: 'secret' }, new AbortController().signal, async () => true);
    directory = await job(f); fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ ok: false, error: 'account_rejected', raw: 'secret' }));
    await assert.rejects(pending, error => error.status === 422 && !error.message.includes('secret'));
  } finally { f.close(); }
});

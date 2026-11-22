const { test } = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/surveillanceLabels.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const exports_ = {}; vm.runInNewContext(source, { exports: exports_, Date, Intl, BigInt });
const notice = (id, change = {}) => ({ id: String(id), popup_enabled: true, read: false, ...change });
test('opening the app establishes a baseline without replaying old alerts', () => {
  const result = exports_.consumeNoticeBatch(null, { latest_id: '50', items: [notice(48), notice(49)] });
  assert.equal(result.cursor, '50'); assert.equal(result.popups.length, 0);
});
test('a large burst advances only through received items and preserves following pages', () => {
  const first = exports_.consumeNoticeBatch('50', { latest_id: '200', items: Array.from({ length: 100 }, (_, i) => notice(i + 51)) });
  assert.equal(first.cursor, '150'); assert.equal(first.popups.length, 100);
  const second = exports_.consumeNoticeBatch(first.cursor, { latest_id: '200', items: Array.from({ length: 50 }, (_, i) => notice(i + 151)) });
  assert.equal(second.cursor, '200'); assert.equal(second.popups[0].id, '151');
});
test('disabled and read alerts advance the cursor without showing a popup; IDs retain bigint precision', () => {
  const result = exports_.consumeNoticeBatch('9007199254740992', { latest_id: '9007199254740995', items: [
    notice('9007199254740995', { popup_enabled: false }), notice('9007199254740994', { read: true }), notice('9007199254740993'),
  ] });
  assert.equal(result.cursor, '9007199254740995'); assert.equal(result.popups.length, 1); assert.equal(result.popups[0].id, '9007199254740993');
});
test('popup queues are bounded and deduplicate repeated polling results', () => {
  const result = exports_.appendPopupNotices([notice(1), notice(2)], [notice(2), notice(3), notice(3), notice(4), notice(5)]);
  assert.equal(result.map(item => item.id).join(','), '3,4,5');
});
test('notification UI never invokes a hardware command while polling, pinning or opening Live', () => {
  for (const file of ['SurveillanceProvider.tsx', 'WatchDialog.tsx', 'PinnedObjects.tsx', 'pages/Notifications.tsx']) {
    const source = fs.readFileSync(path.join(__dirname, '../src', file), 'utf8');
    assert(!/api\.(setDeviceControl|startTalk|ptzCommand)\s*\(/.test(source), file);
  }
});

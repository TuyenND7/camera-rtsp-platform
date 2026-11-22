const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
const code = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/regionGeometry.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
const exports_ = {}; vm.runInNewContext(code, { exports: exports_, Math, Number, JSON });
const plain = value => JSON.parse(JSON.stringify(value));

test('drawing in either direction keeps normalized rectangle aligned with camera coordinates', () => {
  const expected = [[.1, .2], [.7, .2], [.7, .8], [.1, .8]];
  assert.deepEqual(plain(exports_.regionRectangle([.1, .2], [.7, .8])), expected);
  assert.deepEqual(plain(exports_.regionRectangle([.7, .8], [.1, .2])), expected);
  assert.deepEqual(plain(exports_.regionRectangle([2, 3], [-1, -2])), [[0, 0], [1, 0], [1, 1], [0, 1]]);
});
test('too small, flat or non-finite regions cannot be saved', () => {
  for (const points of [[[0, 0], [.01, .5]], [[.1, .1], [.14, .14]], [[0, 0], [1, 0]], [[0, 0], [Infinity, .5]], [[NaN, 0], [.5, .5]]]) assert.equal(exports_.regionRectangle(...points), null);
  assert(exports_.regionRectangle([0, 0], [.05, .05]));
});
test('editing a region detects movement and deletion without marking unchanged settings dirty', () => {
  const zones = [{ id: 'zone-1', name: 'Vùng 1', points: [[0, 0], [.5, 0], [.5, .5], [0, .5]] }];
  assert.equal(exports_.regionDraftChanged(zones, plain(zones)), false);
  assert.equal(exports_.regionDraftChanged(zones, []), true);
  assert.deepEqual(plain(exports_.regionBounds(zones[0].points)), [0, 0, .5, .5]);
});

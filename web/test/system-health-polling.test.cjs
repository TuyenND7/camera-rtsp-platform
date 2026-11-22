const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src/SystemHealthSettings.tsx'), 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX },
}).outputText;
const settled = () => new Promise(setImmediate);

function harness() {
  let effect, timerId = 0;
  const timers = new Map(), requests = [], document = { hidden: false };
  const react = { useRef: value => ({ current: value }), useState: value => [value, () => {}], useEffect: run => { effect = run; } };
  const read = signal => new Promise((resolve, reject) => {
    requests.push({ resolve, reject });
    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  });
  const exports = {};
  vm.runInNewContext(source, {
    exports, AbortController, Date, document,
    window: { setTimeout: run => { const id = ++timerId; timers.set(id, run); return id; }, clearTimeout: id => timers.delete(id) },
    require: name => name === 'react' ? react : name === './systemApi' ? { systemApi: { health: read, performance: read } } : name === 'react/jsx-runtime' ? { jsx: () => null, jsxs: () => null } : {},
  });
  exports.default();
  return { mount: () => effect(), timers, requests, document, fire() { const [id, run] = timers.entries().next().value; timers.delete(id); run(); } };
}

test('StrictMode cleanup cannot revive an old polling loop or leave a timer after unmount', async () => {
  const h = harness();
  h.mount()();
  const unmount = h.mount();
  await settled();
  h.requests.slice(2).forEach(request => request.resolve({}));
  await settled();
  assert.equal(h.requests.length, 4, 'two initial reads per StrictMode setup');
  assert.equal(h.timers.size, 1, 'only the current effect may schedule the next poll');
  const queued = [...h.timers.values()][0];
  unmount();
  assert.equal(h.timers.size, 0);
  queued();
  await settled();
  assert.equal(h.requests.length, 4, 'an already queued callback cannot fetch after unmount');
  assert.equal(h.timers.size, 0);
});

test('hidden pages defer reads and the active polling loop stays singular after a failed read', async () => {
  const h = harness();
  h.document.hidden = true;
  const unmount = h.mount();
  await settled();
  assert.equal(h.requests.length, 0);
  assert.equal(h.timers.size, 1);
  h.document.hidden = false;
  h.fire();
  assert.equal(h.requests.length, 2);
  h.requests[0].reject(new Error('fixture unavailable'));
  h.requests[1].resolve({});
  await settled();
  assert.equal(h.timers.size, 1);
  h.fire();
  assert.equal(h.requests.length, 4);
  h.requests.slice(2).forEach(request => request.resolve({}));
  await settled();
  assert.equal(h.timers.size, 1);
  unmount();
  assert.equal(h.timers.size, 0);
});

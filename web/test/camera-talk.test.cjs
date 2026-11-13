const { test } = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
function script(name) { return ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name + '.ts'), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText; }
const activityExports = {};
vm.runInNewContext(script('speechActivity'), { exports: activityExports, Int16Array, Math });
const flush = () => new Promise(resolve => setImmediate(resolve));
function pcm(amplitude = 0, count = 1600) { return Int16Array.from({ length: count }, (_, i) => Math.sin(i * .4) * 32767 * amplitude).buffer; }
function fixture(options = {}) {
  let now = 0, id = 0, capture;
  const timers = new Map(), events = { starts: [], stops: [], audio: [], states: [], micStops: 0 };
  class Microphone {
    async start(callback) { capture = callback; if (options.permission) await options.permission; }
    stop() { events.micStops++; }
  }
  const api = {
    async startTalk(ids) { events.starts.push(ids); return options.start ? options.start() : { id: 'session-1', max_seconds: 60 }; },
    async stopTalk(id) { events.stops.push(id); },
    async talkAudio(id, seq, audio, signal) { events.audio.push({ id, seq, bytes: audio.byteLength, signal }); if (options.audio) await options.audio(); },
  };
  const exports = {}, add = (callback, ms, repeat) => { timers.set(++id, { callback, due: now + ms, repeat }); return id; };
  vm.runInNewContext(script('cameraTalk'), {
    exports, require: name => name === './api' ? { api } : name === './microphone' ? { Microphone } : activityExports,
    AbortController, DOMException, Error, Uint8Array, performance: { now: () => now },
    window: { setInterval: (fn, ms) => add(fn, ms, ms), setTimeout: (fn, ms) => add(fn, ms, 0), clearInterval: id => timers.delete(id), clearTimeout: id => timers.delete(id) },
  });
  return {
    talk: new exports.CameraTalk(s => events.states.push(s)), events, timers,
    capture: audio => capture(audio),
    advance(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].sort((a, b) => a[1].due - b[1].due)[0];
        if (!next || next[1].due > end) break;
        const [id, timer] = next; now = timer.due;
        if (timer.repeat) timer.due += timer.repeat; else timers.delete(id);
        timer.callback();
      }
      now = end;
    },
  };
}

test('no microphone capture or server session before explicit start; one target only', async () => {
  const f = fixture(); assert.equal(f.events.starts.length, 0); assert.equal(f.timers.size, 0);
  await f.talk.start(2); await f.talk.start(3);
  assert.equal(JSON.stringify(f.events.starts), '[[2]]');
  f.capture(pcm(.1)); await flush(); assert.equal(f.talk.state.phase, 'talking');
  f.talk.stop(); assert.equal(f.talk.state.phase, 'idle'); assert.equal(f.events.micStops, 1);
  assert.equal(f.events.stops[0], 'session-1'); assert.equal(f.events.audio[0].signal.aborted, true); assert.equal(f.timers.size, 0);
});
test('five seconds of silence closes server session and microphone', async () => {
  const f = fixture(); await f.talk.start(2); f.capture(pcm()); await flush();
  f.advance(4999); assert.equal(f.talk.state.phase, 'talking');
  f.advance(1); assert.equal(f.talk.state.phase, 'idle'); assert.match(f.talk.state.message, /5 giây/);
  assert.equal(f.events.micStops, 1); assert.equal(f.events.stops.length, 1); assert.equal(f.timers.size, 0);
});
test('voice resets the five-second period; low noise, DC and a short click do not', async () => {
  const f = fixture(); await f.talk.start(2); f.advance(4000); f.capture(pcm(.1)); await flush();
  f.advance(4000); f.capture(pcm(.003));
  f.capture(new Int16Array(1600).fill(2000).buffer);
  const click = new Int16Array(1600); click.set(new Int16Array(pcm(.9, 80))); f.capture(click.buffer); await flush();
  f.advance(999); assert.equal(f.talk.state.phase, 'talking');
  f.advance(1); assert.equal(f.talk.state.phase, 'idle');
});
test('silence deadline begins when the camera session is ready; a stalled worklet still stops', async () => {
  let ready; const f = fixture({ start: () => new Promise(resolve => { ready = resolve; }) });
  const start = f.talk.start(2); await flush(); f.advance(7000);
  assert.equal(f.talk.state.phase, 'preparing'); ready({ id: 'late-ready', max_seconds: 60 }); await start;
  f.advance(4999); assert.equal(f.talk.state.phase, 'preparing');
  f.advance(1); assert.equal(f.talk.state.phase, 'idle'); assert.equal(f.events.stops[0], 'late-ready');
});
test('stopping while session opens cleans up its late reply without sending audio', async () => {
  let ready; const f = fixture({ start: () => new Promise(resolve => { ready = resolve; }) });
  const start = f.talk.start(2); await flush(); f.talk.stop(); ready({ id: 'cancelled', max_seconds: 60 }); await start;
  f.capture(pcm(.1)); assert.equal(f.events.audio.length, 0); assert.equal(f.events.stops[0], 'cancelled'); assert.equal(f.timers.size, 0);
});
test('stopping before permission resolves never starts a server session', async () => {
  let grant; const f = fixture({ permission: new Promise(resolve => { grant = resolve; }) });
  const start = f.talk.start(2); f.talk.stop(); grant(); await start;
  assert.equal(f.events.starts.length, 0); f.capture(pcm(.1)); assert.equal(f.events.audio.length, 0);
});
test('audio failure closes microphone and a new call starts with sequence zero', async () => {
  let fail = true; const f = fixture({ audio: () => { if (fail) throw new Error('Audio interrupted'); } });
  await f.talk.start(2); f.capture(pcm(.1)); await flush();
  assert.equal(f.talk.state.phase, 'idle'); assert.equal(f.events.stops.length, 1); assert.equal(f.timers.size, 0);
  fail = false; await f.talk.start(3); f.capture(pcm(.1)); await flush();
  assert.equal(f.events.audio[1].seq, 0); f.talk.dispose();
});

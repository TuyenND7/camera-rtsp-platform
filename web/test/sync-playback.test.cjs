const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm'), ts = require('typescript');
function moduleFrom(name) {
  const source = ts.transpileModule(fs.readFileSync(path.join(__dirname, '../src', name), 'utf8'), { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } }).outputText;
  const exports = {};
  vm.runInNewContext(source, { exports, require: () => { throw Error('Unexpected runtime dependency'); }, Intl, Date, Number, URLSearchParams, Set, Map, Math, AbortController, setTimeout, clearTimeout });
  return exports;
}
const time = moduleFrom('syncPlaybackTime.ts'), { SyncClipQueue, syncRequest } = moduleFrom('syncPlaybackLoader.ts');
const start = Date.parse('2026-11-23T03:00:00Z');
function segment(file, at, duration, offset, archive = null) { return { file, url: '/rec/1/20261123/' + file, size: 1, mtime: new Date(at).toISOString(), started_at: new Date(at).toISOString(), duration_s: duration, offset_s: offset, archive_offset_s: archive, thumb_url: null, thumb_tiles: 1 }; }
const data = { playlist: '/rec/1/20261123/index.m3u8', day_playback: { original: '/api/recordings/1/20261123/vod.m3u8', archive: null, duration_s: 120 }, segments: [segment('a.ts', start, 60, 0), segment('b.ts', start + 120000, 60, 60)] };

test('wall-clock mappings preserve a recording gap instead of jumping either camera forwards', () => {
  const segments = time.syncSegments(data.segments), camera = { id: 1, codec: 'h264' };
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 30000).seconds, 30);
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 60000).kind, 'gap');
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 90000).kind, 'gap');
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 120000).seconds, 60);
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 150000).seconds, 90);
  assert.equal(time.syncTarget(camera, '20261123', data, segments, start + 180000).kind, 'gap');
  assert.equal(JSON.stringify(time.syncRanges(segments)), JSON.stringify([[start, start + 60000], [start + 120000, start + 180000]]));
});
test('archive uses its mapped offset, including partial days that need single-segment preparation', () => {
  const archive = { ...data, day_playback: { ...data.day_playback, archive: '/api/recordings/1/20261123/vod.m3u8?source=archive' }, segments: [segment('a.ts', start, 60, 0, 10), segment('b.ts', start + 120000, 60, 60, null)] };
  const segments = time.syncSegments(archive.segments), cam = { id: 1, codec: 'h265' };
  const first = time.syncTarget(cam, '20261123', archive, segments, start + 30000);
  assert.equal(first.seconds, 40); assert.equal(first.offset, 'archive_offset_s');
  assert.equal(time.syncTarget(cam, '20261123', archive, segments, start + 130000).kind, 'prepare');
  const partial = { ...archive, day_playback: { ...archive.day_playback, archive: null } };
  assert.equal(time.syncTarget(cam, '20261123', partial, segments, start + 30000).kind, 'prepare');
  assert.equal(time.syncTarget({ id: 1, codec: 'auto' }, '20261123', partial, segments, start + 30000).kind, 'prepare');
});
test('unfinished and invalid segments never create a playable timestamp or a false recorded range', () => {
  const unfinished = { ...data, segments: [segment('writing.ts', start, 60, null)] };
  assert.equal(time.syncTarget({ id: 1, codec: 'h264' }, '20261123', unfinished, time.syncSegments(unfinished.segments), start + 1000).kind, 'unfinished');
  assert.equal(time.syncSegments([{ ...data.segments[0], duration_s: NaN }, { ...data.segments[0], started_at: null }, { ...data.segments[0], duration_s: -1 }]).length, 0);
});
test('URL input is bounded and does not turn missing/invalid dates into epoch 1970', () => {
  const now = Date.parse('2026-11-23T04:00:00Z');
  const value = time.syncUrlState('?cameras=1,2,2,-3,0,2147483648,3,4,5&day=20260230&at=garbage', 'Asia/Ho_Chi_Minh', now);
  assert.equal(value.cameras.join(','), '1,2,3,4'); assert.equal(value.day, '20261123'); assert.equal(value.at, null);
  const valid = time.syncUrlState('?day=20261123&at=2026-11-22T18%3A30%3A00Z', 'Asia/Ho_Chi_Minh', now);
  assert.equal(valid.at, Date.parse('2026-11-22T18:30:00Z'));
  assert.equal(time.syncUrlState('?day=20261123&at=2026-11-25T18%3A30%3A00Z', 'Asia/Ho_Chi_Minh', now).at, null);
  assert.equal(time.syncUrlState('?at=2026-11-22T18%3A30%3A00', 'Asia/Ho_Chi_Minh', now).at, null);
  assert.equal(time.syncUrlState('?at=2026-02-30T18%3A30%3A00Z', 'Asia/Ho_Chi_Minh', now).at, null);
});
test('calendar follows the server timezone, including civil-time gaps and 23/25-hour days', () => {
  assert.equal(time.syncTimeOnDay('20261123', '00:00:00', 'Asia/Ho_Chi_Minh'), Date.parse('2026-11-22T17:00:00Z'));
  assert.equal(time.syncDayAt(Date.parse('2026-11-22T18:00:00Z'), 'Asia/Ho_Chi_Minh'), '20261123');
  const spring = time.syncDayBounds('20260329', 'Europe/Berlin'), autumn = time.syncDayBounds('20261025', 'Europe/Berlin');
  assert.equal(spring[1] - spring[0], 23 * 3600000); assert.equal(autumn[1] - autumn[0], 25 * 3600000);
  assert.equal(time.syncTimeOnDay('20260329', '02:30:00', 'Europe/Berlin'), null);
  assert.equal(time.syncDayBounds('21001231', 'Asia/Ho_Chi_Minh')[1] - time.syncDayBounds('21001231', 'Asia/Ho_Chi_Minh')[0], 86400000);
});
test('initial common time retains a requested empty interval and remains in the selected day', () => {
  assert.equal(time.chooseSyncStart([data], '20261123', 'Asia/Ho_Chi_Minh', start + 90000), start + 90000);
  assert.equal(time.chooseSyncStart([{ playlist: null, segments: [] }], '20261123', 'Asia/Ho_Chi_Minh', null), Date.parse('2026-11-22T17:00:00Z'));
});
test('only user Play advances the master clock; pause during buffering remains paused after readiness', () => {
  const clock = new time.SyncClock(start, 0);
  clock.block(false, 0); assert.equal(clock.tick(1000), start);
  clock.play(true, 1000); assert.equal(clock.tick(2000), start + 1000);
  clock.block(true, 2000); assert.equal(clock.tick(3000), start + 1000);
  clock.play(false, 3000); clock.block(false, 4000); assert.equal(clock.tick(5000), start + 1000);
  clock.seek(start + 90000, 5000); assert.equal(clock.tick(6000), start + 90000);
  clock.speed(4, 6000); clock.play(true, 6000); assert.equal(clock.tick(7000), start + 94000);
  assert.equal(clock.at(7125), start + 94500); assert.equal(clock.wallMs, start + 94000);
  clock.speed(99, 7000); assert.equal(clock.rate, 4);
  const boundary = Date.parse('2026-11-23T17:00:00Z'); clock.seek(boundary - 500, 7000); clock.speed(1, 7000);
  assert.equal(time.syncDayAt(clock.tick(8000), 'Asia/Ho_Chi_Minh'), '20261124');
});
test('drift correction waits for meaningful drift and a correction interval', () => {
  assert.equal(time.needsSyncCorrection(10, 10.4, 5000, 0), false);
  assert.equal(time.needsSyncCorrection(10, 10.7, 5000, 4900), false);
  assert.equal(time.needsSyncCorrection(10, 10.7, 5000, 4000), true);
  assert.equal(time.needsSyncCorrection(NaN, 10, 5000, 0), false);
});
const flush = () => new Promise(resolve => setImmediate(resolve));
test('preparation deduplicates, limits concurrency to two and drops obsolete requests after a seek', async () => {
  const pending = new Map(), calls = [], changed = [];
  const queue = new SyncClipQueue((id, day, file, signal) => new Promise((resolve, reject) => {
    calls.push(file); pending.set(file, resolve); signal.addEventListener('abort', () => reject(Error('aborted')), { once: true });
  }), () => changed.push('changed'), 1, 1000);
  queue.retain(new Set(['one', 'two', 'three']));
  queue.request('one', 1, '20261123', 'one'); queue.request('two', 2, '20261123', 'two'); queue.request('three', 3, '20261123', 'three'); queue.request('one', 1, '20261123', 'one');
  assert.equal(calls.join(','), 'one,two');
  queue.retain(new Set(['three'])); await flush();
  assert.equal(calls.join(','), 'one,two,three'); assert.equal(queue.get('one'), undefined);
  pending.get('one')({ status: 'ready', playlist: '/obsolete.m3u8', start_position: 99 });
  pending.get('three')({ status: 'ready', playlist: '/playback/prepared/3/x/index.m3u8', start_position: 0 }); await flush();
  assert.equal(queue.get('three').state, 'ready'); assert.equal(queue.get('one'), undefined); queue.dispose();
});
test('conversion polling and request body reads have finite deadlines', async () => {
  let attempts = 0;
  const queue = new SyncClipQueue(async () => { attempts++; return { status: 'processing', playlist: null, error: null, start_position: null }; }, () => {}, 1, 8);
  queue.request('slow', 1, '20261123', 'slow'); await new Promise(resolve => setTimeout(resolve, 25));
  assert.equal(queue.get('slow').state, 'error'); assert(attempts > 0 && attempts < 50); queue.dispose();
  await assert.rejects(syncRequest(new AbortController().signal, () => new Promise(() => {}), 5));
  const parent = new AbortController(), promise = syncRequest(parent.signal, () => new Promise(() => {}), 1000);
  parent.abort(); await assert.rejects(promise, /hủy/);
});

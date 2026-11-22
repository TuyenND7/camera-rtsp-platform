const { test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { PassThrough } = require('node:stream');
const { EventEmitter, once } = require('node:events');
const childProcess = require('node:child_process');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'camera-stream-log-'));
process.env.STORAGE_ROOT = root;
const { StreamDiagnostics, RotatingStreamLog, streamRedactor, checkRtspPort, flushStreamDiagnostics } = require('../dist/stream/diagnostics');
const { readFfmpegLines, startFfmpeg } = require('../dist/stream/ffmpeg');
after(async () => { await flushStreamDiagnostics(); fs.rmSync(root, { recursive: true, force: true }); });

test('redaction covers complete URLs, encoded and decoded credentials before truncation', () => {
  const url = 'rtsp://fixture-user:s%40cret%21@127.0.0.1:554/ch=1&subtype=0';
  const redact = streamRedactor(url);
  const text = `Command failed: ffprobe ${url}\nAuthorization fixture-user s@cret! s%40cret%21\nrtsp://another:another-password@host/path`;
  const safe = redact(text);
  for (const secret of [url, 'fixture-user', 's@cret!', 's%40cret%21', 'another-password']) assert(!safe.includes(secret));
  assert(!redact('x'.repeat(2000) + url + ' s@cret!').includes('s@cret'));
  assert(redact('Connection reset by peer').includes('Connection reset'));
});

test('bounded rotating journal keeps valid JSON across restarts and never grows unbounded', async () => {
  const dir = path.join(root, 'rotation');
  const log = new RotatingStreamLog(dir, 180, 2);
  for (let n = 0; n < 25; n++) log.append(JSON.stringify({ n, message: 'x'.repeat(40) }));
  await log.flush();
  const restarted = new RotatingStreamLog(dir, 180, 2);
  restarted.append(JSON.stringify({ n: 25, message: 'x'.repeat(40) }));
  await restarted.flush();
  const files = fs.readdirSync(dir);
  assert.equal(files.length, 3);
  let bytes = 0;
  const entries = [];
  for (const file of files) {
    const data = fs.readFileSync(path.join(dir, file), 'utf8');
    bytes += Buffer.byteLength(data);
    assert(Buffer.byteLength(data) <= 180);
    entries.push(...data.trim().split('\n').map(line => JSON.parse(line)));
  }
  assert(bytes <= 540);
  assert(entries.some(entry => entry.n === 25));
  assert(!entries.some(entry => entry.n === 0));
});

test('line reader reassembles split UTF-8, credentials and progress records', async () => {
  const pipe = new PassThrough(), lines = [];
  readFfmpegLines(pipe, line => lines.push(line));
  const data = Buffer.from('frame=12\nspeed=0.99x\nprogress=continue\nLỗi rtsp://user:secret@host/x\rfinal');
  for (const byte of data) pipe.write(Buffer.from([byte]));
  pipe.end();
  await once(pipe, 'end');
  assert.deepEqual(lines, ['frame=12', 'speed=0.99x', 'progress=continue', 'Lỗi rtsp://user:secret@host/x', 'final']);
});

test('a run records positive frames, final progress and sanitized stderr without emitting every update', async () => {
  const output = [], original = console.log;
  console.log = line => output.push(JSON.parse(line.slice('[stream] '.length)));
  let trace;
  try {
    trace = new StreamDiagnostics(7, 'rtsp://fixture-user:secret-pass@127.0.0.1:554/test');
    trace.event('probe_result', { stderr: 'rtsp://fixture-user:secret-pass@127.0.0.1:554/test secret-pass' });
    trace.progressLine('frame=0'); trace.progressLine('progress=continue');
    assert(!output.some(e => e.event === 'first_frame'));
    for (const frame of [12, 24, 36]) {
      trace.progressLine('frame=' + frame); trace.progressLine('speed=1.01x'); trace.progressLine('progress=continue');
    }
    for (let n = 0; n < 100; n++) trace.stderr('[hevc] Could not find ref with POC ' + n);
    trace.stderr('Failed reading RTSP data: End of file rtsp://fixture-user:secret-pass@127.0.0.1/test');
    trace.end({ code: 0, signal: null, restart_in_ms: 30000 });
    trace.end({ code: 1 });
    assert.equal(output.filter(e => e.event === 'first_frame').length, 1);
    assert(output.filter(e => e.event === 'ffmpeg_stderr').length <= 8);
    const end = output.find(e => e.event === 'stop');
    assert.equal(end.progress.frame, '36');
    assert.equal(end.stderr_lines, 101);
    assert(end.stderr_tail.some(line => line.includes('End of file')));
    assert.equal(output.filter(e => e.event === 'stop').length, 1);
    assert.equal(new Set(output.map(e => e.run_id)).size, 1);
    const serialized = JSON.stringify(output);
    for (const secret of ['fixture-user', 'secret-pass', 'rtsp://']) assert(!serialized.includes(secret));
  } finally { trace?.end({ reason: 'test_cleanup' }); console.log = original; }
  await flushStreamDiagnostics();
  const persisted = fs.readFileSync(path.join(root, '.stream-diagnostics', 'streams.jsonl'), 'utf8');
  assert(persisted.includes('End of file'));
  assert(!persisted.includes('secret-pass'));
});

test('TCP check opens no RTSP session and reports reachable or refused without credentials', async () => {
  const sockets = new Set(); let bytes = 0;
  const server = net.createServer(socket => { sockets.add(socket); socket.on('data', chunk => bytes += chunk.length); socket.on('close', () => sockets.delete(socket)); });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  try {
    assert.equal((await checkRtspPort(`rtsp://fixture:secret@127.0.0.1:${port}/`)).reachable, true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(bytes, 0);
  } finally { for (const socket of sockets) socket.destroy(); await new Promise(resolve => server.close(resolve)); }
  const refused = await checkRtspPort(`rtsp://fixture:secret@127.0.0.1:${port}/`);
  assert.equal(refused.reachable, false);
  assert.equal(refused.error, 'ECONNREFUSED');
});

test('FFmpeg close retains final stderr and signal; probe errors do not expose raw commands', async () => {
  const oldExec = childProcess.execFile, oldSpawn = childProcess.spawn;
  const proc = new EventEmitter();
  proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
  proc.stdio = [null, proc.stdout, proc.stderr, new PassThrough()]; proc.pid = 123456;
  const events = [], lines = [], exits = [];
  childProcess.execFile = (_bin, _args, _options, callback) => {
    callback(Object.assign(new Error('secret command rtsp://fixture:secret@host'), { code: 'ETIMEDOUT', signal: 'SIGTERM', killed: true }), '', 'Connection timed out');
  };
  childProcess.spawn = () => proc;
  try {
    await startFfmpeg(8, 'rtsp://fixture:secret@host', false, 'h264', (line, source) => lines.push({ line, source }),
      (code, signal) => exits.push({ code, signal }), undefined, (event, details) => events.push({ event, ...details }));
    proc.emit('error', Object.assign(new Error('private command'), { code: 'ENOENT' }));
    proc.emit('exit', null, 'SIGTERM');
    assert.equal(exits.length, 0);
    proc.stderr.end('Failed reading RTSP data: End of file\n');
    await once(proc.stderr, 'end');
    proc.emit('close', null, 'SIGTERM');
    assert.deepEqual(exits, [{ code: null, signal: 'SIGTERM' }]);
    assert(lines.some(e => e.source === 'stderr' && e.line.includes('End of file')));
    assert(events.some(e => e.event === 'probe_result' && e.code === 'ETIMEDOUT' && e.killed));
    assert(events.some(e => e.event === 'process_error' && e.code === 'ENOENT'));
    assert(!JSON.stringify(events).includes('private command'));
    assert(!JSON.stringify(events).includes('secret command'));
  } finally { childProcess.execFile = oldExec; childProcess.spawn = oldSpawn; }
});

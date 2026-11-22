import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';
import { randomUUID } from 'crypto';
import { performance } from 'perf_hooks';
import { execFile } from 'child_process';
import { config } from '../config';

/** Không đưa URL, tài khoản hoặc mật khẩu RTSP vào log, kể cả lỗi từ ffprobe. */
export function streamRedactor(rtspUrl: string): (value: string) => string {
  const secrets = new Set<string>([rtspUrl]);
  try {
    const url = new URL(rtspUrl);
    for (const value of [url.username, url.password]) {
      if (!value) continue;
      secrets.add(value);
      try { secrets.add(decodeURIComponent(value)); } catch { /* malformed escape */ }
    }
  } catch { /* invalid URL is reported without echoing it */ }
  const values = [...secrets].filter(Boolean).sort((a, b) => b.length - a.length);
  return (value) => {
    // Redact before truncating so a long URL cannot leave a credential fragment.
    let clean = value.replace(/(?:rtsp|rtsps):\/\/[^\s<>"']*/gi, '[RTSP]')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1[credentials]@');
    for (const secret of values) clean = clean.split(secret).join('[redacted]');
    return clean.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').slice(0, 2048);
  };
}

/** Một hàng đợi nhỏ, không chặn stream; tối đa 4 file x 5 MiB, còn sau recreate. */
export class RotatingStreamLog {
  private queue: string[] = [];
  private writing?: Promise<void>;
  private warningAt = 0;
  private dropped = 0;

  constructor(private directory: string, private maxBytes = 5 * 1024 * 1024, private archives = 3) {}

  append(line: string): void {
    if (this.queue.length >= 128) { this.dropped++; return; }
    if (Buffer.byteLength(line) > Math.min(32768, this.maxBytes)) { this.dropped++; return; }
    this.queue.push(line + '\n');
    this.startWrite();
  }

  async flush(): Promise<void> { while (this.writing) await this.writing; }

  private startWrite(): void {
    if (!this.writing) this.writing = this.drain().finally(() => {
      this.writing = undefined;
      if (this.queue.length) this.startWrite();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const line = this.queue.shift()!;
      try {
        await fs.promises.mkdir(this.directory, { recursive: true, mode: 0o700 });
        const file = path.join(this.directory, 'streams.jsonl');
        const size = await fs.promises.stat(file).then(s => s.size).catch((err) => {
          if (err.code !== 'ENOENT') throw err;
          return 0;
        });
        if (size && size + Buffer.byteLength(line) > this.maxBytes) {
          await fs.promises.rm(`${file}.${this.archives}`, { force: true });
          for (let i = this.archives - 1; i >= 0; i--) {
            await fs.promises.rename(i ? `${file}.${i}` : file, `${file}.${i + 1}`).catch((err) => {
              if (err.code !== 'ENOENT') throw err;
            });
          }
        }
        await fs.promises.appendFile(file, line, { mode: 0o600 });
      } catch (err) {
        if (Date.now() - this.warningAt > 60_000) {
          this.warningAt = Date.now();
          console.warn('[stream] diagnostic file unavailable:', (err as NodeJS.ErrnoException).code ?? 'write failed');
        }
      }
      if (this.dropped && !this.queue.length) {
        console.warn(`[stream] diagnostic queue overflow: ${this.dropped} entries dropped`);
        this.dropped = 0;
      }
    }
  }
}

const journal = new RotatingStreamLog(path.join(config.storageRoot, '.stream-diagnostics'));
export const flushStreamDiagnostics = () => journal.flush();

let clockTicks: Promise<number> | undefined;
function ticksPerSecond(): Promise<number> {
  return clockTicks ??= new Promise(resolve => execFile('getconf', ['CLK_TCK'], { timeout: 1000 }, (err, out) => {
    resolve(!err && Number(out) > 0 ? Number(out) : 0);
  }));
}

export async function checkRtspPort(rtspUrl: string): Promise<Record<string, unknown>> {
  let url: URL;
  try { url = new URL(rtspUrl); } catch { return { reachable: null, error: 'invalid_url' }; }
  const started = performance.now();
  return new Promise(resolve => {
    const socket = new net.Socket();
    let done = false;
    const deadline = setTimeout(() => finish(false, 'timeout'), 2000);
    const finish = (reachable: boolean, error?: string) => {
      if (done) return;
      done = true;
      clearTimeout(deadline);
      socket.destroy();
      resolve({ reachable, error: error ?? null, elapsed_ms: Math.round(performance.now() - started) });
    };
    socket.once('error', err => finish(false, (err as NodeJS.ErrnoException).code ?? 'socket_error'));
    socket.once('connect', () => finish(true));
    try { socket.connect(Number(url.port || 554), url.hostname.replace(/^\[|\]$/g, '')); }
    catch { finish(false, 'invalid_endpoint'); }
  });
}

/** Một run_id cho mỗi lần spawn, để ghép probe -> frame -> ngắt -> retry. */
export class StreamDiagnostics {
  readonly runId = randomUUID();
  private started = performance.now();
  private redact: (value: string) => string;
  private timer: NodeJS.Timeout;
  private ended = false;
  private pid?: number;
  private progress: Record<string, string> = {};
  private lastProgress?: number;
  private firstFrame = false;
  private lastFrame?: number;
  private lastFrameAt?: number;
  private stderrTail: string[] = [];
  private stderrCount = 0;
  private stderrWindow = 0;
  private stderrWritten = 0;
  private previousCpu?: { ticks: number; at: number };
  private sampleBusy = false;
  private latestSample: Record<string, unknown> | null = null;
  private lastHealthAt = Number.NEGATIVE_INFINITY;

  constructor(private cameraId: number, private rtspUrl: string) {
    this.redact = streamRedactor(rtspUrl);
    this.timer = setInterval(() => void this.sample(), 5000);
    this.timer.unref();
  }

  event(event: string, details: Record<string, unknown> = {}): void {
    const clean = (value: unknown): unknown => {
      if (typeof value === 'string') return this.redact(value);
      if (Array.isArray(value)) return value.slice(-16).map(clean);
      if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, clean(v)]));
      return value;
    };
    const line = JSON.stringify({ at: new Date().toISOString(), camera_id: this.cameraId, run_id: this.runId,
      event, elapsed_ms: Math.round(performance.now() - this.started), ...clean(details) as object });
    journal.append(line);
    console.log(`[stream] ${line}`);
  }

  spawned(pid: number | undefined): void {
    this.pid = pid;
    void this.sample();
  }

  stderr(line: string): void {
    const safe = this.redact(line);
    this.stderrTail.push(safe.slice(0, 512));
    this.stderrTail = this.stderrTail.slice(-8);
    this.stderrCount++;
    // Giữ lỗi ngay lúc ngắt; warning giải mã lặp lại không làm đầy ổ đĩa.
    if (performance.now() - this.stderrWindow >= 10_000) {
      this.stderrWindow = performance.now(); this.stderrWritten = 0;
    }
    if (this.stderrWritten++ < 4 || /end of file|timed? out|connection.*(?:reset|refused|closed)|broken pipe|401|403|404|453|454|500|503/i.test(line)) {
      // Mỗi process vẫn giới hạn 8 dòng/10s kể cả nhóm lỗi kết nối.
      if (this.stderrWritten <= 8) this.event('ffmpeg_stderr', { message: safe });
    }
  }

  progressLine(line: string): void {
    const match = /^([a-zA-Z0-9_]+)=(.*)$/.exec(line);
    if (!match) return;
    const [, key, value] = match;
    if (['frame', 'fps', 'speed', 'out_time_us', 'dup_frames', 'drop_frames'].includes(key)) this.progress[key] = value.slice(0, 40);
    if (key !== 'progress') return;
    const now = performance.now();
    this.lastProgress = now;
    const frame = Number(this.progress.frame);
    if (Number.isFinite(frame) && frame > 0) {
      if (!this.firstFrame) {
        this.firstFrame = true;
        this.event('first_frame', { frame, ...this.progress });
      }
      if (this.lastFrame !== frame) this.lastFrameAt = now;
      this.lastFrame = frame;
    }
  }

  snapshot() {
    return { run_id:this.runId,pid:this.pid??null,elapsed_ms:Math.round(performance.now()-this.started),
      last_progress_age_ms:this.lastProgress===undefined?null:Math.round(performance.now()-this.lastProgress),
      last_frame_change_age_ms:this.lastFrameAt===undefined?null:Math.round(performance.now()-this.lastFrameAt),
      progress:{...this.progress},last_health:this.latestSample?{...this.latestSample}:null };
  }

  private async sample(): Promise<void> {
    if (this.sampleBusy || this.ended) return;
    this.sampleBusy = true;
    try {
      const now = performance.now();
      const playlist = path.join(config.storageRoot, 'live', String(this.cameraId), 'index.m3u8');
      const [stat, content, cpu] = await Promise.all([
        fs.promises.stat(playlist).catch(() => null),
        fs.promises.readFile(playlist, 'utf8').catch(() => ''),
        this.pid && process.platform === 'linux' ? this.processSample(this.pid, now) : Promise.resolve(null),
      ]);
      if (this.ended) return;
      const dates = [...content.matchAll(/#EXT-X-PROGRAM-DATE-TIME:(.+)/g)];
      const durations = [...content.matchAll(/#EXTINF:([\d.]+)/g)];
      const end = dates.length && durations.length
        ? Date.parse(dates[dates.length - 1][1]) + Number(durations[durations.length - 1][1]) * 1000 : NaN;
      this.latestSample = { pid: this.pid ?? null, cpus: os.availableParallelism(), ffmpeg: cpu,
        backend_rss_mb: Math.round(process.memoryUsage().rss / 1048576),
        playlist_age_ms: stat ? Math.max(0, Math.round(Date.now() - stat.mtimeMs)) : null,
        playlist_video_lag_ms: Number.isFinite(end) ? Math.round(Date.now() - end) : null,
        last_progress_age_ms: this.lastProgress === undefined ? null : Math.round(now - this.lastProgress),
        last_frame_change_age_ms: this.lastFrameAt === undefined ? null : Math.round(now - this.lastFrameAt),
        progress: { ...this.progress }, stderr_lines: this.stderrCount, sampled_at: new Date().toISOString() };
      if (now - this.lastHealthAt >= 30_000) {
        this.lastHealthAt = now;
        this.event('health', this.latestSample);
      }
    } finally { this.sampleBusy = false; }
  }

  private async processSample(pid: number, now: number): Promise<Record<string, unknown> | null> {
    try {
      const [stat, status, ticks] = await Promise.all([
        fs.promises.readFile(`/proc/${pid}/stat`, 'utf8'),
        fs.promises.readFile(`/proc/${pid}/status`, 'utf8'), ticksPerSecond(),
      ]);
      const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/\s+/);
      const used = Number(fields[11]) + Number(fields[12]);
      const percent = this.previousCpu && ticks ? Math.round((used - this.previousCpu.ticks) / ticks / ((now - this.previousCpu.at) / 1000) * 100) : null;
      this.previousCpu = { ticks: used, at: now };
      return { cpu_percent: percent, rss_mb: Math.round(Number(status.match(/^VmRSS:\s*(\d+)/m)?.[1] ?? 0) / 1024),
        threads: Number(status.match(/^Threads:\s*(\d+)/m)?.[1] ?? 0) };
    } catch { return null; }
  }

  end(details: Record<string, unknown>, unexpected = false): void {
    if (this.ended) return;
    this.ended = true;
    clearInterval(this.timer);
    this.event(unexpected ? 'exit' : 'stop', { ...details, pid: this.pid ?? null,
      last_progress_age_ms: this.lastProgress === undefined ? null : Math.round(performance.now() - this.lastProgress),
      last_frame_change_age_ms: this.lastFrameAt === undefined ? null : Math.round(performance.now() - this.lastFrameAt),
      progress: { ...this.progress }, stderr_lines: this.stderrCount, stderr_tail: this.stderrTail, last_health: this.latestSample });
    // Chỉ bắt tay TCP, không mở phiên RTSP mới hay chiếm thêm luồng camera.
    if (unexpected) void checkRtspPort(this.rtspUrl).then(result => this.event('rtsp_port_after_exit', result));
  }
}

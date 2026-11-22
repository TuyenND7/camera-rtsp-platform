import { pool } from '../db';
import { startFfmpeg, FfmpegHandle, CodecMode } from './ffmpeg';
import { config } from '../config';
import { rediscoverCamera, rememberSerial } from '../discovery';
import { liveAudio } from './audio';
import { StreamDiagnostics } from './diagnostics';
import { encoderFailed, encodingSignature, EncoderBudget } from '../system/performance';
import { isHardwareEncoderError } from './encoding';

export interface CameraRow {
  id: number;
  name: string;
  rtsp_url: string;
  enabled: boolean;
  record: boolean;
  codec: CodecMode;
  status: string;
}

interface Worker {
  diagnostics: StreamDiagnostics;
  audioGeneration: string;
  lastIdentityCheck: number;
  handle?: FfmpegHandle; // undefined trong lúc đang probe/spawn
  restartTimer?: NodeJS.Timeout;
  stopping: boolean;
  backoffMs: number;
  online: boolean;
  firstFrameAt?: number;
  encoder?: string;
  exited?: boolean;
  transcoding?:boolean;
  budgetSignature?:string;
  hardwareError?:boolean;
}

/** Số lần kết nối hỏng liên tiếp trước khi quét LAN tìm IP mới của camera. */
const FAILURES_BEFORE_REDISCOVERY = 3;

/**
 * Quản lý một FFmpeg process cho mỗi camera đang bật.
 * Tự động khởi động lại (backoff) khi process chết (mất kết nối RTSP).
 */
export class StreamManager {
  private workers = new Map<number, Worker>();
  /** Số lần FFmpeg thoát liên tiếp mà chưa nhận được frame nào. */
  private failures = new Map<number, number>();
  private recordDay = this.currentRecordDay();
  private recordDayTimer?: NodeJS.Timeout;
  private pendingStarts = new Map<number,NodeJS.Timeout>();
  private versions = new Map<number,number>();
  private closing = false;

  health() {
    return [...this.workers].map(([id,worker])=>({camera_id:id,online:worker.online,connecting:!worker.handle,
      retrying:!!worker.restartTimer,backoff_ms:worker.backoffMs,transcoding:!!worker.transcoding,budget_signature:worker.budgetSignature??null,...worker.diagnostics.snapshot()}));
  }

  async bootstrap(): Promise<void> {
    if(this.closing)return;
    const { rows } = await pool.query<CameraRow>(
      'SELECT * FROM cameras WHERE enabled = true'
    );
    if(this.closing)return;
    for (const cam of rows) {
      this.start(cam);
    }
    // FFmpeg ghi playlist theo ngày tại thời điểm nó khởi động. Khởi động lại nhẹ các
    // camera đang record khi qua ngày để không dồn segment mới vào thư mục ngày cũ.
    this.recordDayTimer = setInterval(() => this.rollRecordingDayIfNeeded(), 30_000);
    console.log(`[stream] bootstrapped ${rows.length} camera(s)`);
  }

  private currentRecordDay(): string {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.recordTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    return `${value('year')}${value('month')}${value('day')}`;
  }

  private rollRecordingDayIfNeeded(): void {
    if(this.closing)return;
    const nextDay = this.currentRecordDay();
    if (nextDay === this.recordDay) return;
    this.recordDay = nextDay;
    void pool.query<CameraRow>('SELECT * FROM cameras WHERE enabled = true AND record = true')
      .then(({ rows }) => {
        if(this.closing)return;
        console.log(`[stream] recording day changed to ${nextDay}; restarting ${rows.length} camera(s)`);
        rows.forEach((cam) => void this.restart(cam.id, 'recording_day_changed'));
      })
      .catch((err) => console.error('[stream] failed to roll recording day:', err));
  }

  private async setStatus(id: number, status: string, error?: string | null) {
    await pool
      .query(
        'UPDATE cameras SET status = $1, last_error = $2, updated_at = now() WHERE id = $3',
        [status, error ?? null, id]
      )
      .catch(() => undefined);
  }

  start(cam: CameraRow): void {
    if(this.closing)return;
    if (this.workers.has(cam.id)) return;
    const pending=this.pendingStarts.get(cam.id);
    if(pending)clearTimeout(pending);
    this.pendingStarts.delete(cam.id);
    this.versions.set(cam.id,(this.versions.get(cam.id)??0)+1);
    this.spawn(cam, 1000);
  }

  private spawn(cam: CameraRow, backoffMs: number): void {
    if(this.closing)return;
    void this.setStatus(cam.id, 'connecting');

    // Đăng ký worker placeholder ngay để stop() có thể hủy trong lúc probe
    const worker: Worker = { diagnostics: new StreamDiagnostics(cam.id, cam.rtsp_url), audioGeneration: liveAudio.begin(cam.id), lastIdentityCheck: 0, stopping: false, backoffMs, online: false };
    this.workers.set(cam.id, worker);
    worker.diagnostics.event('start', { backoff_ms: backoffMs, codec_mode: cam.codec ?? 'auto', record: cam.record,
      backend_pid: process.pid, backend_uptime_s: Math.round(process.uptime()), rtsp_read_timeout_ms: 10000,
      transcode_preset: config.transcodePreset, browser_playback_archive: config.browserPlaybackArchive });

    startFfmpeg(
      cam.id,
      cam.rtsp_url,
      cam.record,
      cam.codec ?? 'auto',
      (line, source) => {
        if (source === 'stderr') {
          worker.diagnostics.stderr(line);
          if (worker.transcoding && isHardwareEncoderError(line, worker.encoder)) worker.hardwareError = true;
          return;
        }
        worker.diagnostics.progressLine(line);
        const frame=/^frame=(\d+)$/.exec(line);
        const hasFrames=!!frame&&Number(frame[1])>0;
        // -progress ghi "frame=N" ra stdout khi FFmpeg đã nhận frame thật.
        // Chỉ UPDATE DB một lần mỗi lần spawn thay vì mỗi báo cáo tiến trình.
        if (!worker.stopping && this.workers.get(cam.id) === worker && !worker.online && hasFrames) {
          worker.online = true;
          worker.firstFrameAt=Date.now();
          this.failures.delete(cam.id);
          void this.setStatus(cam.id, 'online', null);
          worker.diagnostics.event('status_online');
        }
        if (hasFrames && worker.firstFrameAt!==undefined && Date.now()-worker.firstFrameAt>=30000) worker.backoffMs=1000;
        if (!worker.stopping && this.workers.get(cam.id) === worker && hasFrames && Date.now() - worker.lastIdentityCheck >= 30_000) {
          worker.lastIdentityCheck = Date.now();
          void rememberSerial(cam.id).catch(() => undefined);
        }
      },
      (code, signal) => this.onExit(cam, code, worker, signal),
      pcm => liveAudio.push(cam.id, worker.audioGeneration, pcm),
      (event, details) => {
        worker.diagnostics.event(event, details);
        if(event==='process_spawned'){
          worker.encoder=String(details.encoder??'software');worker.transcoding=details.live_codec==='h265';
          worker.budgetSignature=details.budget?encodingSignature(details.budget as EncoderBudget):undefined;
        }
        if (event === 'process_spawned' && !worker.stopping) worker.diagnostics.spawned(typeof details.pid === 'number' ? details.pid : undefined);
      }
    )
      .then((handle) => {
        // Nếu đã bị stop trong lúc probe => kill ngay
        if (worker.stopping || worker.exited || this.workers.get(cam.id) !== worker) {
          try {
            handle.proc.kill('SIGTERM');
          } catch {
            /* ignore */
          }
          return;
        }
        worker.handle = handle;
      })
      .catch((err) => {
        worker.diagnostics.event('start_error', { message: err instanceof Error ? err.message : String(err) });
        this.onExit(cam, -1, worker);
      });
  }

  private onExit(cam: CameraRow, code: number | null, expected: Worker, signal: NodeJS.Signals | null = null): void {
    const worker = this.workers.get(cam.id);
    if (worker !== expected || worker.exited) return;
    worker.exited=true;
    if (worker) liveAudio.end(cam.id, worker.audioGeneration);
    if (!worker || worker.stopping) {
      this.workers.delete(cam.id);
      return;
    }
    const err = `ffmpeg exited (code ${code})`;
    void this.setStatus(cam.id, 'error', err);

    // exponential backoff tối đa 30s
    const nextBackoff = Math.min(worker.backoffMs * 2, 30000);
    if(worker.transcoding && worker.hardwareError && worker.encoder)encoderFailed(worker.encoder);
    worker.diagnostics.end({ code, signal, was_online: worker.online, restart_in_ms: worker.backoffMs }, true);
    worker.restartTimer = setTimeout(() => {
      if (worker.stopping || this.workers.get(cam.id) !== worker) return;
      this.workers.delete(cam.id);
      this.spawn(cam, nextBackoff);
    }, worker.backoffMs);

    // Không lên hình nhiều lần liên tiếp: có thể DHCP đã đổi IP camera.
    const failures = worker.online ? 0 : (this.failures.get(cam.id) ?? 0) + 1;
    this.failures.set(cam.id, failures);
    if (failures >= FAILURES_BEFORE_REDISCOVERY) {
      const version = this.versions.get(cam.id);
      void rediscoverCamera(cam.id)
        .then((moved) => {
          worker.diagnostics.event('rediscovery_result', { moved });
          if (!moved || worker.stopping || this.versions.get(cam.id) !== version) return;
          this.failures.delete(cam.id);
          // restart đọc lại rtsp_url mới từ DB.
          return this.restart(cam.id, 'rediscovered_address');
        })
        .catch((error) => worker.diagnostics.event('rediscovery_error', { message: error instanceof Error ? error.message : String(error) }));
    }
  }

  stop(id: number, reason = 'requested'): void {
    this.versions.set(id,(this.versions.get(id)??0)+1);
    const pending=this.pendingStarts.get(id);
    if(pending)clearTimeout(pending);
    this.pendingStarts.delete(id);
    const worker = this.workers.get(id);
    if (!worker) return;
    liveAudio.end(id, worker.audioGeneration);
    worker.stopping = true;
    worker.diagnostics.end({ reason });
    if (worker.restartTimer) clearTimeout(worker.restartTimer);
    if (worker.handle) {
      try {
        worker.handle.proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }
    this.workers.delete(id);
    void this.setStatus(id, 'stopped', null);
  }

  async restart(id: number, reason = 'requested'): Promise<void> {
    if(this.closing)return;
    this.stop(id, reason);
    const version=this.versions.get(id);
    const { rows } = await pool.query<CameraRow>(
      'SELECT * FROM cameras WHERE id = $1',
      [id]
    );
    if (rows[0] && rows[0].enabled && this.versions.get(id)===version) {
      // đợi process cũ thoát hẳn
      this.pendingStarts.set(id,setTimeout(() => {
        this.pendingStarts.delete(id);
        if(this.versions.get(id)===version)this.start(rows[0]);
      }, 1500));
    }
  }

  stopAll(): void {
    this.closing = true;
    if (this.recordDayTimer) clearInterval(this.recordDayTimer);
    for (const id of new Set([...this.workers.keys(),...this.pendingStarts.keys(),...this.versions.keys()])) {
      this.stop(id, 'backend_shutdown');
    }
  }
}

export const streamManager = new StreamManager();

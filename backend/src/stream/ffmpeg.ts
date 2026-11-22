import { spawn, ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { config } from '../config';
import { encoderBudget, EncoderBudget } from '../system/performance';
import { buildStreamArgs } from './encoding';

export type CodecMode = 'auto' | 'h264' | 'h265';

/**
 * Tạo tham số ffmpeg cho một camera:
 * - Output 1: HLS live (playlist ngắn, cuốn chiếu) -> /storage/live/<id>/index.m3u8
 * - Output 2 (nếu record): HLS ghi liên tục thành segment .ts giữ lại
 *   -> /storage/rec/<id>/<YYYYMMDD>/index.m3u8 + segment .ts
 *
 * Codec:
 * - H.264: live dùng "-c:v copy" (nhẹ CPU).
 * - H.265/HEVC: trình duyệt không phát được HLS/HEVC => live phải transcode sang H.264 (libx264).
 * - Recording: LUÔN "-c:v copy" giữ nguyên codec video; audio chuyển AAC cho browser.
 *   File H.265 xem lại được bằng VLC hoặc trình duyệt hỗ trợ.
 */
export interface FfmpegPaths {
  liveDir: string;
  liveIndex: string;
  recDir: string;
  playbackDir: string;
}

export function resolvePaths(cameraId: number): FfmpegPaths {
  const liveDir = path.join(config.storageRoot, 'live', String(cameraId));
  const recDir = path.join(config.storageRoot, 'rec', String(cameraId));
  const playbackDir = path.join(config.storageRoot, 'playback', String(cameraId));
  return {
    liveDir,
    liveIndex: path.join(liveDir, 'index.m3u8'),
    recDir,
    playbackDir,
  };
}

/**
 * Dùng ffprobe phát hiện codec video và kênh audio của luồng RTSP.
 */
export function probeMedia(rtspUrl: string, onResult?: (details: Record<string, unknown>) => void): Promise<{ video: 'h264' | 'h265' | null; audio: boolean }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      rtspUrl,
    ];
    execFile('ffprobe', args, { timeout: 15000 }, (err, stdout, stderr) => {
      if (err) {
        // Error.message của execFile chứa nguyên command/URL, tuyệt đối không log.
        onResult?.({ ok: false, duration_ms: Date.now() - started, code: err.code, signal: err.signal,
          killed: err.killed, stderr });
        resolve({ video: null, audio: false });
        return;
      }
      try {
        const streams = JSON.parse(stdout).streams as Array<{ codec_type: string; codec_name: string }>;
        const name = streams.find(stream => stream.codec_type === 'video')?.codec_name?.toLowerCase() ?? '';
        onResult?.({ ok: true, duration_ms: Date.now() - started, video_codec: name,
          audio_codec: streams.find(stream => stream.codec_type === 'audio')?.codec_name ?? null });
        resolve({ video: /hevc|h265/.test(name) ? 'h265' : /h264|avc/.test(name) ? 'h264' : null, audio: streams.some(stream => stream.codec_type === 'audio') });
      } catch {
        onResult?.({ ok: false, duration_ms: Date.now() - started, error: 'invalid_probe_output', stderr });
        resolve({ video: null, audio: false });
      }
    });
  });
}
export async function probeCodec(rtspUrl: string) { return (await probeMedia(rtspUrl)).video; }

export function buildArgs(
  rtspUrl: string, record: boolean, paths: FfmpegPaths, liveCodec: 'h264' | 'h265',
  audio = false, budget: EncoderBudget = encoderBudget()
): string[] {
  return buildStreamArgs(rtspUrl, record, paths, liveCodec, audio, budget);
}

export interface FfmpegHandle {
  proc: ChildProcess;
  paths: FfmpegPaths;
  liveCodec: 'h264' | 'h265';
  hasAudio: boolean;
}

/** Pipe data có thể chia giữa một dòng/UTF-8; chỉ chuyển dòng hoàn chỉnh cho logger. */
export function readFfmpegLines(stream: Readable, onLine: (line: string) => void): void {
  const decoder = new StringDecoder('utf8');
  let pending = '';
  const consume = (text: string) => {
    pending += text;
    let end: number;
    while ((end = pending.search(/[\r\n]/)) >= 0) {
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      if (line.trim()) onLine(line.trim());
    }
    // FFmpeg không tạo dòng dài như vậy; bỏ phần đầu nếu process lỗi/phun dữ liệu.
    if (pending.length > 16384) pending = pending.slice(-16384);
  };
  stream.on('data', (data: Buffer) => consume(decoder.write(data)));
  stream.on('end', () => { consume(decoder.end()); if (pending.trim()) onLine(pending.trim()); pending = ''; });
}

/**
 * Khởi động ffmpeg cho 1 camera. Async vì có thể phải probe codec trước.
 */
export async function startFfmpeg(
  cameraId: number,
  rtspUrl: string,
  record: boolean,
  codec: CodecMode,
  onLog: (line: string, source: 'progress' | 'stderr') => void,
  onExit: (code: number | null, signal: NodeJS.Signals | null) => void,
  onAudio?: (pcm: Buffer) => void,
  onDiagnostic?: (event: string, details: Record<string, unknown>) => void
): Promise<FfmpegHandle> {
  const paths = resolvePaths(cameraId);
  fs.mkdirSync(paths.liveDir, { recursive: true });
  fs.mkdirSync(paths.recDir, { recursive: true });
  fs.mkdirSync(paths.playbackDir, { recursive: true });

  onDiagnostic?.('probe_start', { timeout_ms: 15000 });
  const media = await probeMedia(rtspUrl, details => onDiagnostic?.('probe_result', details));
  const liveCodec = codec === 'auto' ? media.video ?? 'h264' : codec;
  const budget = encoderBudget();
  const args = buildArgs(rtspUrl, record, paths, liveCodec, media.audio && !!onAudio, budget);
  // Tên file recording (-strftime) luôn theo UTC để API đổi ra giờ chính xác;
  // thư mục ngày vẫn theo RECORD_TIMEZONE (tính ở buildArgs).
  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TZ: 'UTC' },
  });

  if (proc.stderr) readFfmpegLines(proc.stderr, line => onLog(line, 'stderr'));
  if (proc.stdout) readFfmpegLines(proc.stdout, line => onLog(line, 'progress'));
  (proc.stdio[3] as Readable).on('data', (d: Buffer) => onAudio?.(d));
  proc.once('error', err => onDiagnostic?.('process_error', { code: (err as NodeJS.ErrnoException).code ?? null }));
  // close đến sau khi stderr/stdout đã hết: log exit không mất thông báo cuối.
  proc.once('close', (code, signal) => {
    onDiagnostic?.('process_close', { code, signal });
    onExit(code, signal);
  });
  onDiagnostic?.('process_spawned', { pid: proc.pid ?? null, live_codec: liveCodec,
    record, has_audio: media.audio, encoder: budget.encoder, encoder_threads: budget.threads,
    shared_encoder: args.includes('tee'), budget, x264_encoders: args.filter(arg => arg === 'libx264').length });

  return { proc, paths, liveCodec, hasAudio: media.audio };
}

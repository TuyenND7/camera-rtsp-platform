import { spawn, ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Readable } from 'stream';
import { config } from '../config';

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
export function probeMedia(rtspUrl: string): Promise<{ video: 'h264' | 'h265' | null; audio: boolean }> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-show_entries', 'stream=codec_type,codec_name',
      '-of', 'json',
      rtspUrl,
    ];
    execFile('ffprobe', args, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve({ video: null, audio: false });
        return;
      }
      try {
        const streams = JSON.parse(stdout).streams as Array<{ codec_type: string; codec_name: string }>;
        const name = streams.find(stream => stream.codec_type === 'video')?.codec_name?.toLowerCase() ?? '';
        resolve({ video: /hevc|h265/.test(name) ? 'h265' : /h264|avc/.test(name) ? 'h264' : null, audio: streams.some(stream => stream.codec_type === 'audio') });
      } catch { resolve({ video: null, audio: false }); }
    });
  });
}
export async function probeCodec(rtspUrl: string) { return (await probeMedia(rtspUrl)).video; }

export function buildArgs(
  rtspUrl: string,
  record: boolean,
  paths: FfmpegPaths,
  liveCodec: 'h264' | 'h265',
  audio = false
): string[] {
  const args: string[] = [
    '-hide_banner',
    '-loglevel', 'warning',
    // Với loglevel warning, FFmpeg ẩn dòng "frame=" (mức info). Ghi tiến trình
    // key=value ra stdout mỗi 5s để backend biết đã nhận frame và báo online.
    '-nostats',
    '-progress', 'pipe:1',
    '-stats_period', '5',
    // Ưu tiên TCP cho RTSP qua internet (ổn định hơn UDP khi qua NAT)
    '-rtsp_transport', 'tcp',
    '-timeout', '10000000', // 10s (micro giây) chờ kết nối
    '-i', rtspUrl,
  ];

  // ---- Output 1: HLS live (cuốn chiếu, low retention) ----
  args.push('-map', '0:v:0', ...audioOutputArgs());
  if (liveCodec === 'h265') {
    // Transcode HEVC -> H.264 để trình duyệt phát được
    args.push(
      '-c:v', 'libx264',
      '-preset', config.transcodePreset,
      '-tune', 'zerolatency',
      '-b:v', config.transcodeBitrate,
      '-pix_fmt', 'yuv420p',
      // Keyframe đúng mỗi HLS_SEGMENT_SECONDS để segment live dài đúng cấu hình
      // (trước là -g 48 = 2,4s ở 20fps), giảm độ trễ khi xem/điều khiển PTZ.
      '-force_key_frames', `expr:gte(t,n_forced*${config.hlsSegmentSeconds})`,
      '-g', '48'
    );
  } else {
    // H.264: copy, nhẹ CPU
    args.push('-c:v', 'copy');
  }
  args.push(
    '-f', 'hls',
    '-hls_time', String(config.hlsSegmentSeconds),
    '-hls_list_size', String(config.hlsListSize),
    '-hls_flags', 'delete_segments+append_list+omit_endlist',
    '-hls_segment_filename', path.join(paths.liveDir, 'seg_%06d.ts'),
    paths.liveIndex
  );

  // ---- Output 2: recording liên tục (LUÔN copy codec gốc) ----
  if (record) {
    const parts = new Intl.DateTimeFormat('en-CA', {
      timeZone: config.recordTimezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(new Date());
    const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
    const day = `${value('year')}${value('month')}${value('day')}`;
    const dayDir = path.join(paths.recDir, day);
    fs.mkdirSync(dayDir, { recursive: true });
    args.push(
      '-map', '0:v:0',
      '-c:v', 'copy',
      ...audioOutputArgs(),
      '-f', 'hls',
      '-hls_time', String(config.recordSegmentSeconds),
      '-hls_list_size', '0', // giữ tất cả segment trong playlist
      '-hls_flags', 'append_list',
      '-strftime', '1',
      '-hls_segment_filename', path.join(dayDir, 'rec_%Y%m%d_%H%M%S.ts'),
      path.join(dayDir, 'index.m3u8')
    );

    // Recording gốc HEVC giữ nguyên ở /rec. Browser không hỗ trợ HLS/HEVC ổn
    // định, nên tạo archive H.264 tách riêng cho web playback. H.264 nguồn thì
    // dùng luôn recording gốc, không tạo bản sao và không tốn thêm CPU/dung lượng.
    if (liveCodec === 'h265' && config.browserPlaybackArchive) {
      const playbackDayDir = path.join(paths.playbackDir, day);
      fs.mkdirSync(playbackDayDir, { recursive: true });
      args.push(
        '-map', '0:v:0',
        ...audioOutputArgs(),
        '-c:v', 'libx264',
        '-preset', config.browserPlaybackPreset,
        '-b:v', config.browserPlaybackBitrate,
        '-pix_fmt', 'yuv420p',
        '-g', '48',
        '-force_key_frames', `expr:gte(t,n_forced*${config.browserPlaybackSegmentSeconds})`,
        '-f', 'hls',
        '-hls_time', String(config.browserPlaybackSegmentSeconds),
        '-hls_list_size', '0',
        '-hls_flags', 'append_list+independent_segments',
        // Tên theo giờ UTC (spawn TZ=UTC) để API ghép chính xác mốc thời gian
        // giữa recording gốc và archive, kể cả khi camera mất kết nối nhiều lần.
        '-strftime', '1',
        '-hls_segment_filename', path.join(playbackDayDir, 'play_%Y%m%d_%H%M%S.ts'),
        path.join(playbackDayDir, 'index.m3u8')
      );
    }
  }

  if (audio) args.push('-map', '0:a:0', '-vn', '-ac', '1', '-ar', '8000', '-c:a', 'pcm_s16le', '-flush_packets', '1', '-f', 's16le', 'pipe:3');
  return args;
}

/** G.711 from cameras is not browser-compatible; AAC also works in HLS recordings. */
function audioOutputArgs(): string[] {
  return ['-map', '0:a:0?', '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1'];
}

export interface FfmpegHandle {
  proc: ChildProcess;
  paths: FfmpegPaths;
  liveCodec: 'h264' | 'h265';
  hasAudio: boolean;
}

/**
 * Khởi động ffmpeg cho 1 camera. Async vì có thể phải probe codec trước.
 */
export async function startFfmpeg(
  cameraId: number,
  rtspUrl: string,
  record: boolean,
  codec: CodecMode,
  onLog: (line: string) => void,
  onExit: (code: number | null) => void,
  onAudio?: (pcm: Buffer) => void
): Promise<FfmpegHandle> {
  const paths = resolvePaths(cameraId);
  fs.mkdirSync(paths.liveDir, { recursive: true });
  fs.mkdirSync(paths.recDir, { recursive: true });
  fs.mkdirSync(paths.playbackDir, { recursive: true });

  const media = await probeMedia(rtspUrl);
  const liveCodec = codec === 'auto' ? media.video ?? 'h264' : codec;
  const args = buildArgs(rtspUrl, record, paths, liveCodec, media.audio && !!onAudio);
  // Tên file recording (-strftime) luôn theo UTC để API đổi ra giờ chính xác;
  // thư mục ngày vẫn theo RECORD_TIMEZONE (tính ở buildArgs).
  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
    env: { ...process.env, TZ: 'UTC' },
  });

  proc.stderr?.on('data', (d: Buffer) => onLog(d.toString().trim()));
  proc.stdout?.on('data', (d: Buffer) => onLog(d.toString().trim()));
  (proc.stdio[3] as Readable).on('data', (d: Buffer) => onAudio?.(d));
  proc.on('exit', (code) => onExit(code));

  return { proc, paths, liveCodec, hasAudio: media.audio };
}

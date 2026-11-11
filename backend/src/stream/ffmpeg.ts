import { spawn, ChildProcess, execFile } from 'child_process';
import fs from 'fs';
import path from 'path';
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
 * - Recording: LUÔN "-c:v copy" giữ nguyên codec gốc (không tốn CPU, giữ chất lượng).
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
 * Dùng ffprobe phát hiện codec video của luồng RTSP.
 * Trả về 'h264' | 'h265' | null (không xác định được).
 */
export function probeCodec(rtspUrl: string): Promise<'h264' | 'h265' | null> {
  return new Promise((resolve) => {
    const args = [
      '-v', 'error',
      '-rtsp_transport', 'tcp',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=nokey=1:noprint_wrappers=1',
      rtspUrl,
    ];
    execFile('ffprobe', args, { timeout: 15000 }, (err, stdout) => {
      if (err) {
        resolve(null);
        return;
      }
      const name = stdout.trim().toLowerCase();
      if (name.includes('hevc') || name.includes('h265')) resolve('h265');
      else if (name.includes('h264') || name.includes('avc')) resolve('h264');
      else resolve(null);
    });
  });
}

/**
 * Quyết định codec hiệu dụng cho live:
 * - codec='auto' -> probe (nếu probe fail thì mặc định coi là h264/copy).
 * - codec='h264'|'h265' -> dùng luôn, không probe.
 */
async function resolveLiveCodec(
  rtspUrl: string,
  codec: CodecMode
): Promise<'h264' | 'h265'> {
  if (codec === 'h264' || codec === 'h265') return codec;
  const probed = await probeCodec(rtspUrl);
  return probed ?? 'h264';
}

function buildArgs(
  rtspUrl: string,
  record: boolean,
  paths: FfmpegPaths,
  liveCodec: 'h264' | 'h265'
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
  args.push('-map', '0:v:0', '-an');
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
      '-an',
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
        '-an',
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

  return args;
}

export interface FfmpegHandle {
  proc: ChildProcess;
  paths: FfmpegPaths;
  liveCodec: 'h264' | 'h265';
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
  onExit: (code: number | null) => void
): Promise<FfmpegHandle> {
  const paths = resolvePaths(cameraId);
  fs.mkdirSync(paths.liveDir, { recursive: true });
  fs.mkdirSync(paths.recDir, { recursive: true });
  fs.mkdirSync(paths.playbackDir, { recursive: true });

  const liveCodec = await resolveLiveCodec(rtspUrl, codec);
  const args = buildArgs(rtspUrl, record, paths, liveCodec);
  // Tên file recording (-strftime) luôn theo UTC để API đổi ra giờ chính xác;
  // thư mục ngày vẫn theo RECORD_TIMEZONE (tính ở buildArgs).
  const proc = spawn('ffmpeg', args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, TZ: 'UTC' },
  });

  proc.stderr?.on('data', (d: Buffer) => onLog(d.toString().trim()));
  proc.stdout?.on('data', (d: Buffer) => onLog(d.toString().trim()));
  proc.on('exit', (code) => onExit(code));

  return { proc, paths, liveCodec };
}

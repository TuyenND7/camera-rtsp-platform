import { ChildProcess, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';

export interface BrowserPlaybackState {
  status: 'ready' | 'processing' | 'error';
  playlist: string | null;
  error: string | null;
  /** Vị trí bắt đầu (giây) trong archive H.264 tự tạo. */
  start_position: number | null;
}

interface PlaybackJob extends BrowserPlaybackState {
  process?: ChildProcess;
}

/**
 * Chuyển recording HEVC đã có sang HLS H.264 khi người dùng mở Playback.
 * Bản gốc vẫn nằm nguyên ở /storage/rec; kết quả web-friendly nằm ở /playback.
 */
class BrowserPlaybackManager {
  private jobs = new Map<string, PlaybackJob>();

  prepare(cameraId: string, day: string, from?: string): BrowserPlaybackState {
    const segmentKey = from ? path.parse(from).name : 'full';
    const key = `${cameraId}/${day}/${segmentKey}`;
    const outputDir = path.join(config.storageRoot, 'playback', 'prepared', cameraId, day, segmentKey);
    const playlistFile = path.join(outputDir, 'index.m3u8');
    const playlistUrl = `/playback/prepared/${cameraId}/${day}/${segmentKey}/index.m3u8`;
    const sourceDir = path.join(config.storageRoot, 'rec', cameraId, day);
    if (!fs.existsSync(sourceDir)) {
      return { status: 'error', playlist: null, error: 'Không tìm thấy recording nguồn', start_position: null };
    }
    const allSegments = fs.readdirSync(sourceDir).filter((file) => file.endsWith('.ts')).sort();
    const segments = from ? allSegments.filter((file) => file === from) : allSegments;
    if (from && segments.length === 0) {
      return { status: 'error', playlist: null, error: 'Segment playback không tồn tại', start_position: null };
    }
    if (segments.length === 0) {
      return { status: 'error', playlist: null, error: 'Recording chưa có segment nào', start_position: null };
    }
    const sourceDuration = from
      ? segmentDuration(path.join(sourceDir, 'index.m3u8'), from)
      : playlistDuration(path.join(sourceDir, 'index.m3u8'));
    const dayDuration = playlistDuration(path.join(sourceDir, 'index.m3u8'));
    // Archive tự tạo khi camera đang ghi chỉ có phần video kể từ lúc worker start;
    // chỉ dùng nó khi đã phủ toàn bộ playlist recording của ngày đó. Khi có,
    // phát thẳng archive local và nhảy tới offset của segment đã bấm — không
    // phải đợi FFmpeg chuyển đổi lại từng segment H.265.
    const automaticPlaylist = path.join(config.storageRoot, 'playback', cameraId, day, 'index.m3u8');
    if (playlistCovers(automaticPlaylist, dayDuration)) {
      const state: PlaybackJob = {
        status: 'ready',
        playlist: `/playback/${cameraId}/${day}/index.m3u8`,
        error: null,
        start_position: from ? segmentOffset(path.join(sourceDir, 'index.m3u8'), from) : null,
      };
      this.jobs.set(key, state);
      return this.publicState(state);
    }
    const existing = this.jobs.get(key);
    if (existing?.status === 'processing') return this.publicState(existing);
    if (playlistCovers(playlistFile, sourceDuration)) {
      const state: PlaybackJob = { status: 'ready', playlist: playlistUrl, error: null, start_position: null };
      this.jobs.set(key, state);
      return this.publicState(state);
    }

    // Đây là output on-demand tách biệt archive đang ghi, nên không bao giờ ghi
    // đè playlist H.264 của worker FFmpeg hiện hành.
    fs.rmSync(outputDir, { recursive: true, force: true });
    fs.mkdirSync(outputDir, { recursive: true });
    const concatFile = path.join(outputDir, '.concat.txt');
    fs.writeFileSync(concatFile, segments.map((file) => `file '${path.join(sourceDir, file).replace(/'/g, "'\\''")}'`).join('\n') + '\n');

    const job: PlaybackJob = { status: 'processing', playlist: null, error: null, start_position: null };
    this.jobs.set(key, job);
    const args = [
      '-hide_banner', '-loglevel', 'warning', '-y',
      '-fflags', '+genpts', '-f', 'concat', '-safe', '0', '-i', concatFile,
      '-map', '0:v:0', '-map', '0:a:0?',
      '-c:a', 'aac', '-b:a', '64k', '-ar', '16000', '-ac', '1',
      '-c:v', 'libx264', '-preset', config.browserPlaybackPreset,
      '-b:v', config.browserPlaybackBitrate, '-pix_fmt', 'yuv420p', '-g', '48',
      '-force_key_frames', `expr:gte(t,n_forced*${config.browserPlaybackSegmentSeconds})`,
      '-f', 'hls', '-hls_time', String(config.browserPlaybackSegmentSeconds),
      '-hls_list_size', '0', '-hls_flags', 'independent_segments',
      '-hls_segment_filename', path.join(outputDir, 'play_%06d.ts'), playlistFile,
    ];
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    job.process = proc;
    let lastError = '';
    proc.stderr?.on('data', (chunk: Buffer) => { lastError = chunk.toString().trim(); });
    proc.on('exit', (code) => {
      try { fs.unlinkSync(concatFile); } catch { /* ignore */ }
      job.process = undefined;
      if (code === 0 && playlistCovers(playlistFile, sourceDuration)) {
        job.status = 'ready';
        job.playlist = playlistUrl;
        job.error = null;
        console.log(`[playback] browser playlist ready for ${key}`);
      } else {
        job.status = 'error';
        job.playlist = null;
        job.start_position = null;
        job.error = lastError || `FFmpeg playback transcode thất bại (code ${code})`;
        console.error(`[playback] transcode failed for ${key}: ${job.error}`);
      }
    });
    return this.publicState(job);
  }

  private publicState(job: PlaybackJob): BrowserPlaybackState {
    return { status: job.status, playlist: job.playlist, error: job.error, start_position: job.start_position ?? null };
  }
}

function playlistCovers(playlist: string, sourceDuration: number): boolean {
  if (!fs.existsSync(playlist)) return false;
  // Không có duration nguồn (playlist lỗi/cũ) thì output hoàn chỉnh vẫn dùng được.
  if (sourceDuration <= 0) return fs.readFileSync(playlist, 'utf8').includes('#EXT-X-ENDLIST');
  return playlistDuration(playlist) >= sourceDuration * 0.98;
}

function playlistDuration(playlist: string): number {
  if (!fs.existsSync(playlist)) return 0;
  return Array.from(fs.readFileSync(playlist, 'utf8').matchAll(/#EXTINF:([0-9.]+)/g))
    .reduce((total, match) => total + Number(match[1]), 0);
}

function segmentDuration(playlist: string, segment: string): number {
  if (!fs.existsSync(playlist)) return 0;
  let pendingDuration = 0;
  for (const line of fs.readFileSync(playlist, 'utf8').split(/\r?\n/)) {
    const match = /^#EXTINF:([0-9.]+)/.exec(line);
    if (match) {
      pendingDuration = Number(match[1]);
      continue;
    }
    if (pendingDuration && path.basename(line) === segment) return pendingDuration;
  }
  return 0;
}

function segmentOffset(playlist: string, segment: string): number {
  if (!fs.existsSync(playlist)) return 0;
  let offset = 0;
  let pendingDuration = 0;
  for (const line of fs.readFileSync(playlist, 'utf8').split(/\r?\n/)) {
    const match = /^#EXTINF:([0-9.]+)/.exec(line);
    if (match) {
      pendingDuration = Number(match[1]);
      continue;
    }
    if (!pendingDuration || !line || line.startsWith('#')) continue;
    if (path.basename(line) === segment) return offset;
    offset += pendingDuration;
    pendingDuration = 0;
  }
  return 0;
}

export const browserPlaybackManager = new BrowserPlaybackManager();

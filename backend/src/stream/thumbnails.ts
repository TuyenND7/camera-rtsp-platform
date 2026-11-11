import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { isNotFound } from '../fsutil';

/** Kích thước một khung preview trong sprite (px). Web dùng cùng giá trị. */
export const THUMB_WIDTH = 160;
export const THUMB_HEIGHT = 90;
/** Mỗi sprite chứa 1 khung cho mỗi THUMB_INTERVAL giây của segment. */
export const THUMB_INTERVAL_SECONDS = 10;

const BATCH_SIZE = 5;
const IDLE_DELAY_MS = 20_000;
const BUSY_DELAY_MS = 500;
const FFMPEG_TIMEOUT_MS = 60_000;

/** Segment lỗi (file hỏng) không thử lại liên tục trong cùng một lần chạy backend. */
const failed = new Set<string>();

export function thumbsDir(cameraId: string, day: string): string {
  return path.join(config.storageRoot, 'thumbs', cameraId, day);
}

export function thumbFileName(segment: string): string {
  return segment.replace(/\.ts$/, '.jpg');
}

/**
 * Tạo sprite preview (ảnh nhỏ theo chiều ngang) cho từng segment recording đã
 * hoàn tất. Chạy nền, ưu tiên segment mới nhất, mỗi lần tối đa BATCH_SIZE file
 * để segment vừa ghi xong có preview sớm dù đang backfill ngày cũ.
 */
export function startThumbnailJob(): { stop(): void } {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;

  const run = async () => {
    let hasMore = false;
    try {
      hasMore = await generateBatch(() => stopped);
    } catch (err) {
      console.error('[thumbs] error:', err);
    }
    if (!stopped) timer = setTimeout(() => void run(), hasMore ? BUSY_DELAY_MS : IDLE_DELAY_MS);
  };
  timer = setTimeout(() => void run(), 2_000);

  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/** Trả true nếu còn segment chưa có preview sau batch này. */
async function generateBatch(isStopped: () => boolean): Promise<boolean> {
  const recRoot = path.join(config.storageRoot, 'rec');
  let budget = BATCH_SIZE;

  for (const cameraId of await listDirs(recRoot)) {
    const days = (await listDirs(path.join(recRoot, cameraId)))
      .filter((day) => /^\d{8}$/.test(day))
      .sort()
      .reverse();
    for (const day of days) {
      const dayDir = path.join(recRoot, cameraId, day);
      // Chỉ segment đã nằm trong playlist mới chắc chắn FFmpeg ghi xong.
      const durations = await readDurations(path.join(dayDir, 'index.m3u8'));
      if (durations.size === 0) continue;
      const outDir = thumbsDir(cameraId, day);
      await fs.promises.mkdir(outDir, { recursive: true });
      const existing = new Set(await fs.promises.readdir(outDir));
      const pending = Array.from(durations.keys())
        .filter((segment) => !existing.has(thumbFileName(segment)) && !failed.has(`${cameraId}/${day}/${segment}`))
        .sort()
        .reverse();

      for (const segment of pending) {
        if (isStopped()) return false;
        if (budget <= 0) return true;
        budget--;
        const ok = await generateSprite(
          path.join(dayDir, segment),
          path.join(outDir, thumbFileName(segment)),
          durations.get(segment) ?? config.recordSegmentSeconds
        );
        if (!ok) failed.add(`${cameraId}/${day}/${segment}`);
      }
    }
  }
  return false;
}

function generateSprite(source: string, target: string, durationS: number): Promise<boolean> {
  const tiles = Math.max(1, Math.ceil(durationS / THUMB_INTERVAL_SECONDS));
  const partial = target.replace(/\.jpg$/, '.part.jpg');
  const filter = [
    'setpts=PTS-STARTPTS',
    `select='gte(t,selected_n*${THUMB_INTERVAL_SECONDS})'`,
    `scale=${THUMB_WIDTH}:${THUMB_HEIGHT}:force_original_aspect_ratio=decrease`,
    `pad=${THUMB_WIDTH}:${THUMB_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
    `tile=${tiles}x1`,
  ].join(',');
  // Chỉ decode keyframe (-skip_frame nokey) và 1 thread: ~2s CPU cho 60s HEVC 3K,
  // không tranh CPU với FFmpeg đang ghi/transcode live.
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin', '-threads', '1',
    '-skip_frame', 'nokey', '-i', source, '-an', '-sn',
    '-vf', filter, '-frames:v', '1', '-q:v', '5', '-y', partial,
  ];

  return new Promise((resolve) => {
    const proc = spawn('ffmpeg', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let lastError = '';
    proc.stderr?.on('data', (chunk: Buffer) => { lastError = chunk.toString().trim(); });
    const killer = setTimeout(() => proc.kill('SIGKILL'), FFMPEG_TIMEOUT_MS);
    proc.on('error', () => undefined);
    proc.on('close', async (code) => {
      clearTimeout(killer);
      try {
        if (code !== 0) throw new Error(lastError || `ffmpeg exited ${code}`);
        await fs.promises.rename(partial, target);
        resolve(true);
      } catch (err) {
        await fs.promises.rm(partial, { force: true }).catch(() => undefined);
        console.warn(`[thumbs] cannot create preview for ${path.basename(source)}: ${(err as Error).message}`);
        resolve(false);
      }
    });
  });
}

async function listDirs(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function readDurations(playlist: string): Promise<Map<string, number>> {
  const durations = new Map<string, number>();
  let text: string;
  try {
    text = await fs.promises.readFile(playlist, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return durations;
    throw err;
  }
  let pending: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^#EXTINF:([0-9.]+)/.exec(line);
    if (match) {
      pending = Number(match[1]);
    } else if (pending !== null && line && !line.startsWith('#')) {
      durations.set(path.basename(line), pending);
      pending = null;
    }
  }
  return durations;
}

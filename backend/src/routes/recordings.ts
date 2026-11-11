import { Router } from 'express';
import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { requireAuth } from '../middleware/auth';
import { getStorageStatus } from '../stream/retention';
import { browserPlaybackManager } from '../stream/playback';
import { isNotFound, mapLimit, STAT_CONCURRENCY, statIfExists } from '../fsutil';
import {
  THUMB_HEIGHT, THUMB_INTERVAL_SECONDS, THUMB_WIDTH, thumbFileName, thumbsDir,
} from '../stream/thumbnails';

const router = Router();
router.use(requireAuth);

/** Thông tin filesystem của volume storage và chính sách auto-cleanup. */
router.get('/storage', async (_req, res) => {
  try {
    res.json(await getStorageStatus());
  } catch (err) {
    console.error('[recordings] cannot read storage status:', err);
    res.status(500).json({ error: 'Không đọc được dung lượng storage' });
  }
});

/**
 * Liệt kê các ngày có recording của 1 camera.
 * GET /api/recordings/:cameraId/days -> ["20260911", ...]
 */
router.get('/:cameraId/days', (req, res) => {
  if (!isCameraId(req.params.cameraId)) {
    res.status(400).json({ error: 'cameraId không hợp lệ' });
    return;
  }
  const camDir = path.join(config.storageRoot, 'rec', String(req.params.cameraId));
  if (!fs.existsSync(camDir)) {
    res.json([]);
    return;
  }
  const days = fs
    .readdirSync(camDir)
    .filter((d) => fs.statSync(path.join(camDir, d)).isDirectory())
    .sort()
    .reverse();
  res.json(days);
});

/** Chuẩn bị HLS H.264 cho recording HEVC để playback/seek được trong browser. */
router.post('/:cameraId/:day/browser-playback', (req, res) => {
  const { cameraId, day } = req.params;
  if (!isCameraId(cameraId) || !isDay(day)) {
    res.status(400).json({ error: 'Camera hoặc ngày không hợp lệ' });
    return;
  }
  const from = typeof req.body?.from === 'string' ? path.basename(req.body.from) : undefined;
  res.json(browserPlaybackManager.prepare(cameraId, day, from));
});

/**
 * Liệt kê segment của 1 ngày.
 * GET /api/recordings/:cameraId/:day -> danh sách file + playlist url
 */
router.get('/:cameraId/:day', async (req, res) => {
  const { cameraId, day } = req.params;
  if (!isCameraId(cameraId) || !isDay(day)) {
    res.status(400).json({ error: 'Camera hoặc ngày không hợp lệ' });
    return;
  }
  const dayDir = path.join(config.storageRoot, 'rec', String(cameraId), String(day));
  try {
    let files: string[];
    try {
      files = await fs.promises.readdir(dayDir);
    } catch (err) {
      if (!isNotFound(err)) throw err;
      res.json({ playlist: null, segments: [] });
      return;
    }
    const durations = segmentDurations(dayDir);
    const tsFiles = files.filter((f) => f.endsWith('.ts')).sort();
    // stat song song (bất đồng bộ): trên bind mount Windows, stat tuần tự vài trăm
    // file mất gần 1 giây và chặn mọi request khác của backend.
    const stats = new Map<string, fs.Stats>();
    await mapLimit(tsFiles, STAT_CONCURRENCY, async (f) => {
      const st = await statIfExists(path.join(dayDir, f));
      if (st) stats.set(f, st);
    });
    const thumbs = new Set(await readdirIfExists(thumbsDir(cameraId, day)));
    const recEntries = parsePlaylist(await readFileIfExists(path.join(dayDir, 'index.m3u8')));
    const archiveDir = path.join(config.storageRoot, 'playback', cameraId, day);
    const archiveText = await readFileIfExists(path.join(archiveDir, 'index.m3u8'));
    const offsets = playlistOffsets(recEntries);
    const archiveOffsets = await mapToArchive(recEntries, parsePlaylist(archiveText), archiveDir);
    const recordedSeconds = recEntries.reduce((sum, entry) => sum + entry.duration, 0);

    const segments = [];
    for (const f of tsFiles) {
      const st = stats.get(f);
      if (!st) continue;
      const duration = durations.get(f) ?? config.recordSegmentSeconds;
      const thumb = thumbFileName(f);
      segments.push({
        file: f,
        url: `/rec/${cameraId}/${day}/${f}`,
        size: st.size,
        mtime: st.mtime,
        started_at: startedAtFromFilename(f),
        duration_s: duration,
        // Vị trí trong playlist cả ngày để web seek bằng currentTime (không tải lại
        // video). null = file FFmpeg đang ghi dở, chưa nằm trong playlist.
        offset_s: offsets.get(f) ?? null,
        archive_offset_s: archiveOffsets?.get(f) ?? null,
        thumb_url: thumbs.has(thumb) ? `/thumbs/${cameraId}/${day}/${thumb}` : null,
        thumb_tiles: Math.max(1, Math.ceil(duration / THUMB_INTERVAL_SECONDS)),
      });
    }

    const hasPlaylist = files.includes('index.m3u8');
    const archiveDuration = parsePlaylist(archiveText).reduce((sum, entry) => sum + entry.duration, 0);
    const archiveCovers = archiveOffsets !== null && archiveDuration >= recordedSeconds * 0.98;
    res.json({
      playlist: hasPlaylist ? `/rec/${cameraId}/${day}/index.m3u8` : null,
      day_playback: {
        original: hasPlaylist ? `/api/recordings/${cameraId}/${day}/vod.m3u8` : null,
        archive: archiveCovers ? `/api/recordings/${cameraId}/${day}/vod.m3u8?source=archive` : null,
        duration_s: Number(recordedSeconds.toFixed(3)),
      },
      thumb: { width: THUMB_WIDTH, height: THUMB_HEIGHT, interval_s: THUMB_INTERVAL_SECONDS },
      segments,
    });
  } catch (err) {
    console.error('[recordings] cannot list day:', err);
    res.status(500).json({ error: 'Không đọc được recording của ngày đã chọn' });
  }
});

/**
 * Trả playlist playback bắt đầu từ một segment đã chọn. Playlist kết thúc tại
 * segment mới nhất hiện có để user xem lại ổn định trong khi FFmpeg vẫn ghi.
 */
router.get('/:cameraId/:day/playlist', (req, res) => {
  const { cameraId, day } = req.params;
  if (!isCameraId(cameraId) || !isDay(day)) {
    res.status(400).json({ error: 'Camera hoặc ngày không hợp lệ' });
    return;
  }
  const dayDir = path.join(config.storageRoot, 'rec', cameraId, day);
  const from = typeof req.query.from === 'string' ? path.basename(req.query.from) : '';
  if (!fs.existsSync(dayDir)) {
    res.status(404).json({ error: 'Không có recording cho ngày đã chọn' });
    return;
  }
  const segments = fs.readdirSync(dayDir).filter((file) => file.endsWith('.ts')).sort();
  const durations = segmentDurations(dayDir);
  const startIndex = from ? segments.indexOf(from) : 0;
  if (from && startIndex < 0) {
    res.status(400).json({ error: 'Segment bắt đầu không hợp lệ' });
    return;
  }
  const selected = segments.slice(Math.max(0, startIndex));
  const targetDuration = selected.reduce(
    (max, file) => Math.max(max, durations.get(file) ?? config.recordSegmentSeconds),
    1
  );
  const playlist = [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${Math.ceil(targetDuration)}`,
    ...selected.flatMap((file) => [
      `#EXTINF:${(durations.get(file) ?? config.recordSegmentSeconds).toFixed(3)},`,
      `/rec/${cameraId}/${day}/${encodeURIComponent(file)}`,
    ]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  res.type('application/vnd.apple.mpegurl').send(playlist);
});

/**
 * Playlist VOD cả ngày (có ENDLIST) để player biết tổng thời lượng và seek tự do.
 * source=original: recording gốc (H.264). source=archive: bản H.264 của camera HEVC.
 * Giữ nguyên EXT-X-DISCONTINUITY của FFmpeg (mỗi lần camera kết nối lại).
 */
router.get('/:cameraId/:day/vod.m3u8', async (req, res) => {
  const { cameraId, day } = req.params;
  const source = req.query.source === 'archive' ? 'archive' : 'original';
  if (!isCameraId(cameraId) || !isDay(day)) {
    res.status(400).json({ error: 'Camera hoặc ngày không hợp lệ' });
    return;
  }
  const base = source === 'archive' ? `/playback/${cameraId}/${day}` : `/rec/${cameraId}/${day}`;
  const file = path.join(config.storageRoot, base, 'index.m3u8');
  try {
    const text = await fs.promises.readFile(file, 'utf8');
    const lines = text.split(/\r?\n/).filter((line) => line && line !== '#EXT-X-ENDLIST');
    const body = lines.map((line) => (line.startsWith('#') ? line : `${base}/${encodeURIComponent(path.basename(line))}`));
    body.splice(1, 0, '#EXT-X-PLAYLIST-TYPE:VOD');
    res.type('application/vnd.apple.mpegurl').set('Cache-Control', 'no-cache').send([...body, '#EXT-X-ENDLIST', ''].join('\n'));
  } catch (err) {
    if (isNotFound(err)) {
      res.status(404).json({ error: 'Không có playlist cho ngày đã chọn' });
      return;
    }
    console.error('[recordings] cannot build VOD playlist:', err);
    res.status(500).json({ error: 'Không đọc được playlist' });
  }
});

function isCameraId(value: string): boolean {
  return /^\d+$/.test(value);
}

function isDay(value: string): boolean {
  return /^\d{8}$/.test(value);
}

interface PlaylistEntry {
  file: string;
  duration: number;
  /** Chỉ số khối giữa các EXT-X-DISCONTINUITY (mỗi lần camera kết nối lại). */
  block: number;
}

function parsePlaylist(text: string | null): PlaylistEntry[] {
  const entries: PlaylistEntry[] = [];
  if (!text) return entries;
  let block = 0;
  let pending: number | null = null;
  for (const line of text.split(/\r?\n/)) {
    if (line === '#EXT-X-DISCONTINUITY') {
      if (entries.length > 0) block++;
      continue;
    }
    const match = /^#EXTINF:([0-9.]+)/.exec(line);
    if (match) {
      pending = Number(match[1]);
    } else if (pending !== null && line && !line.startsWith('#')) {
      entries.push({ file: path.basename(line), duration: pending, block });
      pending = null;
    }
  }
  return entries;
}

function playlistOffsets(entries: PlaylistEntry[]): Map<string, number> {
  const offsets = new Map<string, number>();
  let offset = 0;
  for (const entry of entries) {
    offsets.set(entry.file, Number(offset.toFixed(3)));
    offset += entry.duration;
  }
  return offsets;
}

/**
 * Đổi vị trí trong recording gốc sang vị trí trong archive H.264 theo GIỜ THỰC
 * của từng segment, không dựa vào thứ tự khối DISCONTINUITY (archive thường có
 * thêm khối khi FFmpeg khởi động lại, làm lệch hàng giờ nếu ghép theo chỉ số).
 * - Recording: giờ bắt đầu nằm trong tên file rec_YYYYMMDD_HHMMSS.ts (UTC).
 * - Archive mới: play_YYYYMMDD_HHMMSS.ts (UTC). Archive cũ play_NNNNNN.ts: FFmpeg
 *   đóng file khi segment sau bắt đầu, nên mtime ≈ giờ kết thúc.
 */
async function mapToArchive(rec: PlaylistEntry[], archive: PlaylistEntry[], archiveDir: string): Promise<Map<string, number> | null> {
  if (rec.length === 0 || archive.length === 0) return null;
  const mtimes = archiveMtimeCache(archiveDir);
  const starts: Array<number | null> = archive.map((entry) => segmentTime(entry.file, 'play_'));
  const unnamed = starts.flatMap((start, index) => (start === null ? [index] : []));
  await mapLimit(unnamed, STAT_CONCURRENCY, async (index) => {
    const file = archive[index].file;
    let mtime = mtimes.get(file);
    if (mtime === undefined) {
      const st = await statIfExists(path.join(archiveDir, file));
      if (!st) return;
      mtime = st.mtimeMs;
      mtimes.set(file, mtime);
    }
    starts[index] = mtime - archive[index].duration * 1000;
  });

  const timeline: Array<{ start: number; end: number; offset: number }> = [];
  let offset = 0;
  archive.forEach((entry, index) => {
    const start = starts[index];
    if (start !== null) timeline.push({ start, end: start + entry.duration * 1000, offset });
    offset += entry.duration;
  });
  timeline.sort((a, b) => a.start - b.start);

  const result = new Map<string, number>();
  for (const entry of rec) {
    const recStart = segmentTime(entry.file, 'rec_');
    if (recStart === null) continue;
    let lo = 0;
    let hi = timeline.length - 1;
    let found = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (timeline[mid].start <= recStart) { found = mid; lo = mid + 1; } else hi = mid - 1;
    }
    const hit = found >= 0 && recStart < timeline[found].end ? timeline[found] : null;
    if (hit) {
      result.set(entry.file, Number((hit.offset + (recStart - hit.start) / 1000).toFixed(3)));
      continue;
    }
    // Archive bắt đầu trễ vài giây sau recording (lúc FFmpeg vừa kết nối).
    const next = timeline[found + 1];
    if (next && next.start - recStart <= 5000) result.set(entry.file, Number(next.offset.toFixed(3)));
  }
  return result.size > 0 ? result : null;
}

/** mtime của segment archive đã hoàn tất không đổi: cache theo ngày (giữ 3 ngày gần nhất). */
const mtimeCaches = new Map<string, Map<string, number>>();
function archiveMtimeCache(dir: string): Map<string, number> {
  let cache = mtimeCaches.get(dir);
  if (!cache) {
    cache = new Map();
    mtimeCaches.set(dir, cache);
    while (mtimeCaches.size > 3) mtimeCaches.delete(mtimeCaches.keys().next().value as string);
  }
  return cache;
}

/** Giờ UTC (ms) trong tên segment <prefix>YYYYMMDD_HHMMSS.ts. */
function segmentTime(file: string, prefix: string): number | null {
  const match = new RegExp(`^${prefix}(\\d{4})(\\d{2})(\\d{2})_(\\d{2})(\\d{2})(\\d{2})\\.ts$`).exec(file);
  if (!match) return null;
  const [, y, mo, d, h, mi, s] = match.map(Number);
  return Date.UTC(y, mo - 1, d, h, mi, s);
}

async function readFileIfExists(file: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(file, 'utf8');
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function readdirIfExists(dir: string): Promise<string[]> {
  try {
    return await fs.promises.readdir(dir);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

/** FFmpeg chạy với TZ=UTC nên tên file là giờ UTC; trả ISO có 'Z' để web đổi ra giờ địa phương. */
function startedAtFromFilename(file: string): string | null {
  const match = /^rec_(\d{8})_(\d{6})\.ts$/.exec(file);
  if (!match) return null;
  const [, day, time] = match;
  return `${day.slice(0, 4)}-${day.slice(4, 6)}-${day.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}Z`;
}

function segmentDurations(dayDir: string): Map<string, number> {
  const playlist = path.join(dayDir, 'index.m3u8');
  const durations = new Map<string, number>();
  if (!fs.existsSync(playlist)) return durations;
  let pendingDuration: number | null = null;
  for (const line of fs.readFileSync(playlist, 'utf8').split(/\r?\n/)) {
    const match = /^#EXTINF:([0-9.]+)/.exec(line);
    if (match) {
      pendingDuration = Number(match[1]);
      continue;
    }
    if (pendingDuration !== null && line && !line.startsWith('#')) {
      durations.set(path.basename(line), pendingDuration);
      pendingDuration = null;
    }
  }
  return durations;
}

export default router;

import fs from 'fs';
import path from 'path';
import { config } from '../config';
import { isNotFound, mapLimit, STAT_CONCURRENCY, statIfExists } from '../fsutil';

export interface StorageStatus {
  label: string;
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  used_percent: number;
  recording_bytes: number;
  recording_days: number;
  cleanup_threshold_percent: number;
  cleanup_target_percent: number;
  /** Các ngày recording đã bị tự xoá gần đây (mới nhất trước). */
  recent_cleanups: CleanupRecord[];
}

export interface CleanupRecord {
  at: string;
  camera_id: number;
  day: string;
  bytes: number;
  reason: 'storage quota' | 'retention';
  used_percent: number | null;
}

/** Nhật ký xoá recording, lưu trong storage để còn sau khi backend khởi động lại. */
const CLEANUP_LOG_LIMIT = 100;
function cleanupLogFile(): string {
  return path.join(config.storageRoot, 'cleanup-log.json');
}

async function readCleanupLog(): Promise<CleanupRecord[]> {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(cleanupLogFile(), 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    if (!isNotFound(err)) console.warn('[retention] cannot read cleanup log:', (err as Error).message);
    return [];
  }
}

async function appendCleanupLog(records: CleanupRecord[]): Promise<void> {
  if (records.length === 0) return;
  const all = [...(await readCleanupLog()), ...records].slice(-CLEANUP_LOG_LIMIT);
  const temp = `${cleanupLogFile()}.tmp`;
  await fs.promises.writeFile(temp, JSON.stringify(all, null, 1));
  await fs.promises.rename(temp, cleanupLogFile());
}

interface RecordingDay {
  path: string;
  day: string;
  bytes: number;
  newestMtimeMs: number;
}

interface RecordingSummary {
  bytes: number;
  days: number;
}

interface DiskUsage {
  total: number;
  free: number;
  used: number;
  usedPercent: number;
}

// Quét toàn bộ recording phải stat hàng nghìn file; trên bind mount Windows việc
// này mất vài giây. Kết quả được cache sau mỗi lần job chạy để trang Storage không
// phải quét lại, và quét bằng fs.promises để không chặn event loop của API/stream.
let cachedSummary: RecordingSummary | null = null;
let scanInFlight: Promise<RecordingDay[]> | null = null;
let cleanupRunning = false;

/**
 * Dọn recording theo hai chính sách an toàn:
 * - RECORD_RETENTION_HOURS > 0: xoá nguyên ngày recording đã quá hạn.
 * - Dung lượng filesystem chứa /storage >= ngưỡng: xoá nguyên ngày cũ nhất
 *   cho tới mức target. Không chạm live stream, snapshot AI, hay ngày đang ghi.
 */
export function startRetentionJob(): NodeJS.Timeout {
  let lastStarted = Number.NEGATIVE_INFINITY;
  const run = async () => {
    const now = Date.now();
    if (cleanupRunning || now - lastStarted < config.storageCleanupIntervalMinutes * 60_000) return;
    lastStarted = now;
    cleanupRunning = true;
    try {
      await cleanup();
    } catch (err) {
      console.error('[retention] error:', err);
    } finally {
      cleanupRunning = false;
    }
  };
  void run();
  return setInterval(() => void run(), 60_000);
}

/**
 * Dung lượng filesystem luôn đọc mới (statfs rất nhanh). Số liệu recording lấy từ
 * cache của job retention; chỉ quét trực tiếp khi job chưa chạy xong lần đầu.
 */
export async function getStorageStatus(): Promise<StorageStatus> {
  const summary = cachedSummary ?? summarize(await scanRecordingDays());
  const disk = diskUsage();
  return {
    label: config.storageLabel,
    total_bytes: disk.total,
    used_bytes: disk.used,
    free_bytes: disk.free,
    used_percent: disk.usedPercent,
    recording_bytes: summary.bytes,
    recording_days: summary.days,
    cleanup_threshold_percent: config.storageCleanupThresholdPercent,
    cleanup_target_percent: cleanupTargetPercent(),
    recent_cleanups: (await readCleanupLog()).slice(-20).reverse(),
  };
}

async function cleanup(): Promise<void> {
  const retentionHours = config.recordRetentionHours;
  const thresholdPercent = config.storageCleanupThresholdPercent;
  const targetPercent = cleanupTargetPercent();
  let days = await scanRecordingDays();
  const today = currentRecordDay();
  const cutoff = retentionHours > 0
    ? Date.now() - retentionHours * 3600 * 1000
    : null;
  let removed = 0;
  let removedBytes = 0;
  const log: CleanupRecord[] = [];
  const record = (day: RecordingDay, reason: CleanupRecord['reason'], usedPercent: number | null) => log.push({
    at: new Date().toISOString(),
    camera_id: Number(path.basename(path.dirname(day.path))),
    day: day.day,
    bytes: day.bytes,
    reason,
    used_percent: usedPercent,
  });

  // Chỉ xoá ngày đã kết thúc: playlist không bị hỏng và không đụng segment FFmpeg đang ghi.
  if (cutoff !== null) {
    const kept: RecordingDay[] = [];
    for (const day of days) {
      if (day.day < today && day.newestMtimeMs < cutoff) {
        await removeDay(day, 'retention');
        record(day, 'retention', null);
        removed++;
        removedBytes += day.bytes;
      } else {
        kept.push(day);
      }
    }
    days = kept;
  }

  let disk = diskUsage();
  if (disk.usedPercent >= thresholdPercent) {
    const bytesToFree = Math.max(0, disk.used - Math.floor(disk.total * targetPercent / 100));
    let quotaFreed = 0;
    const candidates = days.filter((day) => day.day < today).sort((a, b) => a.day.localeCompare(b.day));
    const removedDays = new Set<RecordingDay>();

    console.warn(
      `[retention] storage is ${disk.usedPercent}% full (threshold ${thresholdPercent}%); freeing old recording days toward ${targetPercent}%`
    );
    for (const day of candidates) {
      if (quotaFreed >= bytesToFree) break;
      await removeDay(day, 'storage quota');
      record(day, 'storage quota', disk.usedPercent);
      removedDays.add(day);
      removed++;
      removedBytes += day.bytes;
      quotaFreed += day.bytes;
    }
    days = days.filter((day) => !removedDays.has(day));
    disk = diskUsage();
    if (disk.usedPercent >= thresholdPercent) {
      console.warn(`[retention] storage is still ${disk.usedPercent}% full; no older completed recording day remains to remove`);
    }
  }

  cachedSummary = summarize(days);
  await appendCleanupLog(log).catch((err) => console.error('[retention] cannot write cleanup log:', err));
  if (removed > 0) {
    console.log(`[retention] removed ${removed} completed recording day(s), ${formatBytes(removedBytes)} freed`);
  }
}

function diskUsage(): DiskUsage {
  const stat = fs.statfsSync(config.storageRoot);
  const total = Number(stat.blocks) * Number(stat.bsize);
  const free = Number(stat.bavail) * Number(stat.bsize);
  const used = Math.max(0, total - free);
  return {
    total,
    free,
    used,
    usedPercent: total > 0 ? Number(((used / total) * 100).toFixed(1)) : 0,
  };
}

function cleanupTargetPercent(): number {
  return Math.min(config.storageCleanupTargetPercent, config.storageCleanupThresholdPercent);
}

function summarize(days: RecordingDay[]): RecordingSummary {
  return { bytes: days.reduce((sum, day) => sum + day.bytes, 0), days: days.length };
}

/** Gộp các lời gọi quét đồng thời (job + request Storage) thành một lần quét. */
function scanRecordingDays(): Promise<RecordingDay[]> {
  if (!scanInFlight) {
    scanInFlight = collectRecordingDays().finally(() => {
      scanInFlight = null;
    });
  }
  return scanInFlight;
}

async function collectRecordingDays(): Promise<RecordingDay[]> {
  const recRoot = path.join(config.storageRoot, 'rec');
  const results: RecordingDay[] = [];

  for (const cameraId of await listDirectories(recRoot)) {
    const camDir = path.join(recRoot, cameraId);
    for (const day of await listDirectories(camDir)) {
      if (!/^\d{8}$/.test(day)) continue;
      const dayDir = path.join(camDir, day);
      const recording = await directoryStats(dayDir, false);
      // Bản H.264 phục vụ browser playback là dẫn xuất của ngày recording này.
      const archive = await directoryStats(path.join(config.storageRoot, 'playback', cameraId, day), true);
      const prepared = await directoryStats(path.join(config.storageRoot, 'playback', 'prepared', cameraId, day), true);
      results.push({
        path: dayDir,
        day,
        bytes: recording.bytes + archive.bytes + prepared.bytes,
        newestMtimeMs: recording.newestMtimeMs,
      });
    }
  }
  return results;
}

async function listDirectories(dir: string): Promise<string[]> {
  try {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  } catch (err) {
    if (isNotFound(err)) return [];
    throw err;
  }
}

async function directoryStats(dir: string, recursive: boolean): Promise<{ bytes: number; newestMtimeMs: number }> {
  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if (isNotFound(err)) return { bytes: 0, newestMtimeMs: 0 };
    throw err;
  }

  let bytes = 0;
  let newestMtimeMs = 0;
  const files = entries.filter((entry) => entry.isFile()).map((entry) => path.join(dir, entry.name));
  await mapLimit(files, STAT_CONCURRENCY, async (file) => {
    const st = await statIfExists(file);
    if (!st) return;
    bytes += st.size;
    newestMtimeMs = Math.max(newestMtimeMs, st.mtimeMs);
  });

  if (recursive) {
    for (const entry of entries.filter((item) => item.isDirectory())) {
      const child = await directoryStats(path.join(dir, entry.name), true);
      bytes += child.bytes;
      newestMtimeMs = Math.max(newestMtimeMs, child.newestMtimeMs);
    }
  }
  return { bytes, newestMtimeMs };
}

async function removeDay(day: RecordingDay, reason: string): Promise<void> {
  const cameraId = path.basename(path.dirname(day.path));
  await fs.promises.rm(day.path, { recursive: true, force: true });
  // Bản H.264 phục vụ browser playback là dẫn xuất của recording gốc, nên dọn
  // cùng ngày để quota thực sự được giải phóng và không để orphan files.
  await fs.promises.rm(path.join(config.storageRoot, 'playback', cameraId, day.day), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.storageRoot, 'playback', 'prepared', cameraId, day.day), { recursive: true, force: true });
  await fs.promises.rm(path.join(config.storageRoot, 'thumbs', cameraId, day.day), { recursive: true, force: true });
  console.log(`[retention] removed ${day.path} (${formatBytes(day.bytes)}, ${reason})`);
}

function currentRecordDay(): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: config.recordTimezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? '';
  return `${value('year')}${value('month')}${value('day')}`;
}

function formatBytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

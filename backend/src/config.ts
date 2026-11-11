import dotenv from 'dotenv';
dotenv.config();

function num(v: string | undefined, def: number): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function percent(v: string | undefined, def: number): number {
  return Math.min(100, Math.max(1, num(v, def)));
}

export const config = {
  nodeEnv: process.env.NODE_ENV ?? 'development',
  port: num(process.env.PORT, 4000),

  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://camadmin:change_me_db_pass@localhost:5432/camera_platform',

  jwtSecret: process.env.JWT_SECRET ?? 'dev_insecure_secret_change_me',
  jwtExpiresIn: process.env.JWT_EXPIRES_IN ?? '12h',
  cookieSecure: process.env.COOKIE_SECURE === 'true',

  adminUsername: process.env.ADMIN_USERNAME ?? 'admin',
  adminPassword: process.env.ADMIN_PASSWORD ?? 'admin',

  storageRoot: process.env.STORAGE_ROOT ?? '/storage',
  storageLabel: process.env.STORAGE_LABEL ?? 'Camera storage',
  // 0 = giữ recording cho tới khi quota dung lượng yêu cầu dọn.
  recordRetentionHours: Math.max(0, num(process.env.RECORD_RETENTION_HOURS, 0)),
  storageCleanupThresholdPercent: percent(process.env.STORAGE_CLEANUP_THRESHOLD_PERCENT, 90),
  storageCleanupTargetPercent: percent(process.env.STORAGE_CLEANUP_TARGET_PERCENT, 85),
  storageCleanupIntervalMinutes: Math.max(1, num(process.env.STORAGE_CLEANUP_INTERVAL_MINUTES, 10)),
  // Giữ segment gốc ngắn để người dùng chọn một mốc H.265 thì bản chuyển đổi
  // playback không phải xử lý đến 10 phút video trong một lần.
  recordSegmentSeconds: Math.max(10, num(process.env.RECORD_SEGMENT_SECONDS, 60)),
  // H.265 recording gốc không phát/seek được trên Chrome. Tạo HLS H.264 riêng
  // cho playback web, vẫn giữ nguyên recording copy gốc ở /rec.
  browserPlaybackArchive: process.env.BROWSER_PLAYBACK_ARCHIVE !== 'false',
  browserPlaybackSegmentSeconds: Math.max(2, num(process.env.BROWSER_PLAYBACK_SEGMENT_SECONDS, 10)),
  browserPlaybackPreset: process.env.BROWSER_PLAYBACK_PRESET || 'veryfast',
  browserPlaybackBitrate: process.env.BROWSER_PLAYBACK_BITRATE || '2000k',
  hlsSegmentSeconds: num(process.env.HLS_SEGMENT_SECONDS, 2),
  hlsListSize: num(process.env.HLS_LIST_SIZE, 6),
  recordTimezone: process.env.RECORD_TIMEZONE ?? 'Asia/Ho_Chi_Minh',

  // Transcode (dùng khi camera H.265 -> H.264 cho live để trình duyệt phát được)
  transcodePreset: process.env.TRANSCODE_PRESET ?? 'veryfast',
  transcodeBitrate: process.env.TRANSCODE_BITRATE ?? '2000k',
};

export type AppConfig = typeof config;

if (config.nodeEnv === 'production' && (config.jwtSecret.length < 32 || /change_me|dev_insecure/i.test(config.jwtSecret))) {
  throw new Error('JWT_SECRET must be a unique random secret of at least 32 characters in production');
}

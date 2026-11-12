CREATE TABLE IF NOT EXISTS users (
  id          SERIAL PRIMARY KEY,
  username    TEXT UNIQUE NOT NULL,
  password    TEXT NOT NULL,          -- bcrypt hash
  role        TEXT NOT NULL DEFAULT 'admin',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Store only a SHA-256 digest. Deleting a session revokes API and media access.
CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions (expires_at);

-- Global web settings, applied after .env defaults on every backend startup.
CREATE TABLE IF NOT EXISTS application_settings (
  id SMALLINT PRIMARY KEY CHECK (id = 1),
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS cameras (
  id           SERIAL PRIMARY KEY,
  name         TEXT NOT NULL,
  rtsp_url     TEXT NOT NULL,         -- rtsp://user:pass@ip:port/path
  enabled      BOOLEAN NOT NULL DEFAULT true,
  record       BOOLEAN NOT NULL DEFAULT true,
  codec        TEXT NOT NULL DEFAULT 'auto',      -- auto | h264 | h265
  ai_enabled   BOOLEAN NOT NULL DEFAULT false,
  ai_rtsp_url  TEXT,                              -- ưu tiên sub-stream của NVR cho AI
  ai_fps       REAL NOT NULL DEFAULT 2,
  ai_confidence REAL NOT NULL DEFAULT 0.5,
  ai_labels    TEXT[] NOT NULL DEFAULT ARRAY['person', 'car', 'motorcycle'],
  status       TEXT NOT NULL DEFAULT 'stopped',  -- stopped | connecting | online | error
  last_error   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Migration idempotent cho DB đã tồn tại từ trước (chưa có cột codec)
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS codec TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_rtsp_url TEXT;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_fps REAL NOT NULL DEFAULT 2;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_confidence REAL NOT NULL DEFAULT 0.5;
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS ai_labels TEXT[] NOT NULL DEFAULT ARRAY['person', 'car', 'motorcycle'];
-- PTZ qua ONVIF. NULL = http://<host RTSP>/onvif/device_service, dùng tài khoản RTSP.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS onvif_url TEXT;
-- Serial ONVIF: nhận ra camera khi DHCP đổi IP để tự cập nhật địa chỉ.
ALTER TABLE cameras ADD COLUMN IF NOT EXISTS device_serial TEXT;

-- Tên preset PTZ do người dùng đặt. Nhiều camera (vd Tenda) không lưu tên hoặc
-- không nhận tên có dấu, nên camera chỉ giữ token còn tên nằm ở đây.
CREATE TABLE IF NOT EXISTS ptz_presets (
  camera_id   INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  token       TEXT NOT NULL,
  name        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (camera_id, token)
);

-- Metadata cho từng file recording segment
CREATE TABLE IF NOT EXISTS recordings (
  id          SERIAL PRIMARY KEY,
  camera_id   INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  file_path   TEXT NOT NULL,          -- đường dẫn tương đối trong /storage/rec
  started_at  TIMESTAMPTZ NOT NULL,
  duration_s  INTEGER,
  size_bytes  BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_recordings_camera_time
  ON recordings (camera_id, started_at DESC);

-- Sự kiện do worker AI ghi lại. Snapshot nằm trong /storage/events và không đặt blob vào DB.
CREATE TABLE IF NOT EXISTS detection_events (
  id            BIGSERIAL PRIMARY KEY,
  camera_id     INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  detected_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  label         TEXT NOT NULL,
  confidence    REAL NOT NULL,
  snapshot_path TEXT,
  source        TEXT NOT NULL DEFAULT 'ai',
  metadata      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_detection_events_camera_time
  ON detection_events (camera_id, detected_at DESC);
